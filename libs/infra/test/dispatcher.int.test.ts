import { randomUUID } from 'node:crypto';
import { QUEUES } from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { freshTestDb } from '../../../test/test-db.js';
import { testEnv } from '../../../test/test-env.js';
import { JobEntity } from '../src/db/entities/job.entity.js';
import { WorkflowRunEntity } from '../src/db/entities/workflow-run.entity.js';
import { seedMerchant } from '../src/db/seed.js';
import { Dispatcher } from '../src/jobs/dispatcher.js';
import { HandlerRegistry, systemHandlers } from '../src/jobs/handlers.js';
import { createRunInTransaction, enqueueInTransaction } from '../src/jobs/job-store.js';
import { QueueSet } from '../src/jobs/queues.js';
import { JobRunner } from '../src/jobs/runner.js';
import { QueueWorkers } from '../src/jobs/workers.js';

const redisUrl = testEnv().REDIS_URL;
let ds: DataSource;
let merchantId: string;
const opened: { close: () => Promise<void> }[] = [];
const prefixes: string[] = [];

function queueSet() {
  const prefix = `test-${randomUUID().slice(0, 8)}`;
  prefixes.push(prefix);
  const qs = new QueueSet({ redisUrl, prefix });
  opened.push(qs);
  return { qs, prefix };
}

async function newJobs(n: number, type = 'system.noop') {
  return ds.transaction(async (em) => {
    const run = await createRunInTransaction(em, { merchantId, kind: 'system_test' });
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(
        (
          await enqueueInTransaction(em, {
            merchantId,
            workflowRunId: run.id,
            type,
            queue: 'media',
            idempotencyKey: randomUUID(),
          })
        ).job.id,
      );
    }
    return { runId: run.id, ids };
  });
}

const status = async (ids: string[]) =>
  (await ds.getRepository(JobEntity).findBy(ids.map((id) => ({ id })))).map((j) => j.status);

beforeAll(async () => {
  ds = await freshTestDb();
  merchantId = (
    await seedMerchant(ds, {
      merchantName: 'A',
      merchantSlug: 'shop-a',
      email: 'a@a.local',
      password: 'password-a',
      displayName: 'A',
    })
  ).merchant.id;
});
afterEach(async () => {
  while (opened.length) await opened.pop()?.close();
  await ds.query('TRUNCATE workflow_runs CASCADE');
});
afterAll(async () => {
  for (const prefix of prefixes) {
    const qs = new QueueSet({ redisUrl, prefix });
    for (const q of QUEUES) await qs.get(q).obliterate({ force: true });
    await qs.close();
  }
  await ds.destroy();
});

describe('outbox dispatcher (real Postgres + Redis)', () => {
  it('rolls back the job with the domain transaction', async () => {
    const key = randomUUID();
    await expect(
      ds.transaction(async (em) => {
        const run = await createRunInTransaction(em, { merchantId, kind: 'system_test' });
        await enqueueInTransaction(em, {
          merchantId,
          workflowRunId: run.id,
          type: 'system.noop',
          queue: 'media',
          idempotencyKey: key,
        });
        throw new Error('domain change failed');
      }),
    ).rejects.toThrow('domain change failed');
    expect(await ds.getRepository(JobEntity).countBy({ idempotencyKey: key })).toBe(0);
    expect(await ds.getRepository(WorkflowRunEntity).count()).toBe(0);
  });

  it('is idempotent per key: the second enqueue returns the first job', async () => {
    const key = randomUUID();
    const [first, second] = await ds.transaction(async (em) => {
      const run = await createRunInTransaction(em, { merchantId, kind: 'system_test' });
      const a = await enqueueInTransaction(em, {
        merchantId,
        workflowRunId: run.id,
        type: 'system.noop',
        queue: 'media',
        idempotencyKey: key,
      });
      const b = await enqueueInTransaction(em, {
        merchantId,
        workflowRunId: run.id,
        type: 'system.noop',
        queue: 'media',
        idempotencyKey: key,
      });
      return [a, b];
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
  });

  it('enqueues a job committed while the dispatcher was stopped, and a worker runs it', async () => {
    const { ids } = await newJobs(1);
    expect(await status(ids)).toEqual(['pending']);
    const { qs, prefix } = queueSet();
    const dispatcher = new Dispatcher(ds, qs, { pollMs: 50 });
    const workers = new QueueWorkers(
      { redisUrl, prefix, concurrency: { media: 1, ai: 1, render: 1 } },
      new JobRunner(ds, new HandlerRegistry().register(systemHandlers[0]!), { workerId: 'test-worker' }),
    );
    opened.push({ close: () => dispatcher.stop() }, workers);
    workers.start(['media']);
    dispatcher.start();
    await expect.poll(() => status(ids), { timeout: 10_000, interval: 100 }).toEqual(['succeeded']);
  });

  it('two dispatchers never enqueue the same job twice', async () => {
    const { ids } = await newJobs(60);
    const { qs } = queueSet();
    const d1 = new Dispatcher(ds, qs, { batchSize: 7 });
    const d2 = new Dispatcher(ds, qs, { batchSize: 7 });
    const drain = async (d: Dispatcher) => {
      let n = 0;
      for (let got = await d.tick(); got > 0; got = await d.tick()) n += got;
      return n;
    };
    const [n1, n2] = await Promise.all([drain(d1), drain(d2)]);
    expect(n1 + n2).toBe(60);
    expect(n1).toBeGreaterThan(0);
    expect(n2).toBeGreaterThan(0);
    const counts = await qs.get('media').getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(60);
    expect(new Set(await status(ids))).toEqual(new Set(['queued']));
  });

  it('recovers queued rows whose message was lost (crash between commit and enqueue)', async () => {
    const { ids } = await newJobs(3);
    const { qs } = queueSet();
    const d = new Dispatcher(ds, qs, { lostAfterMs: 0 });
    const claimed = await d.claimDue(); // committed as queued, never published = crash
    expect(claimed.map((c) => c.id).sort()).toEqual([...ids].sort());
    expect(await d.recoverLost()).toBe(3);
    expect(new Set(await status(ids))).toEqual(new Set(['pending']));
    expect(await d.tick()).toBe(3);
    expect(await d.recoverLost()).toBe(0); // messages exist now → nothing to recover
    expect((await qs.get('media').getJobCounts('waiting')).waiting).toBe(3);
  });

  it('does not dispatch jobs before run_after', async () => {
    const { ids } = await newJobs(1);
    await ds.query(`UPDATE jobs SET run_after = now() + interval '1 hour' WHERE id = $1`, [ids[0]]);
    const { qs } = queueSet();
    expect(await new Dispatcher(ds, qs).tick()).toBe(0);
    expect(await status(ids)).toEqual(['pending']);
  });
});
