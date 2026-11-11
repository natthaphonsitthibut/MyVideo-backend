import { randomUUID } from 'node:crypto';
import { QUEUES } from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { freshTestDb } from '../../../test/test-db.js';
import { testEnv } from '../../../test/test-env.js';
import { JobEntity } from '../src/db/entities/job.entity.js';
import { seedMerchant } from '../src/db/seed.js';
import { Dispatcher } from '../src/jobs/dispatcher.js';
import { FatalJobError, HandlerRegistry, type JobHandler } from '../src/jobs/handlers.js';
import { createRunInTransaction, enqueueInTransaction } from '../src/jobs/job-store.js';
import { bullJobId, QueueSet } from '../src/jobs/queues.js';
import { JobRunner } from '../src/jobs/runner.js';
import { QueueWorkers } from '../src/jobs/workers.js';

const redisUrl = testEnv().REDIS_URL;
let ds: DataSource;
let merchantId: string;
const calls = new Map<string, number>();
const handlers: JobHandler[] = [
  {
    type: 'test.flaky',
    queue: 'media',
    run: async ({ job }) => {
      const n = (calls.get(job.id) ?? 0) + 1;
      calls.set(job.id, n);
      if (n <= 2) throw new Error(`transient failure ${n}`);
      return { calls: n };
    },
  },
  {
    type: 'test.fatal',
    queue: 'media',
    run: async () => Promise.reject(new FatalJobError('bad input file')),
  },
  { type: 'test.always', queue: 'media', run: async () => Promise.reject(new Error('still broken')) },
  {
    type: 'test.count',
    queue: 'media',
    run: async ({ job }) => {
      calls.set(job.id, (calls.get(job.id) ?? 0) + 1);
      return {};
    },
  },
];

let stack: { close: () => Promise<void> }[] = [];
let prefix = '';
let qs: QueueSet;

async function startStack() {
  prefix = `test-${randomUUID().slice(0, 8)}`;
  qs = new QueueSet({ redisUrl, prefix });
  const registry = new HandlerRegistry();
  for (const h of handlers) registry.register(h);
  const runner = new JobRunner(ds, registry, {
    workerId: 'w-test',
    backoff: { baseMs: 50, capMs: 200 },
    heartbeatMs: 100,
  });
  const workers = new QueueWorkers({ redisUrl, prefix, concurrency: { media: 1, ai: 1, render: 1 } }, runner);
  const dispatcher = new Dispatcher(ds, qs, { pollMs: 25 });
  workers.start(['media']);
  dispatcher.start();
  stack = [{ close: () => dispatcher.stop() }, workers, qs];
  return { runner };
}

async function addJob(type: string, maxAttempts = 3) {
  return ds.transaction(async (em) => {
    const run = await createRunInTransaction(em, { merchantId, kind: 'system_test' });
    return (
      await enqueueInTransaction(em, {
        merchantId,
        workflowRunId: run.id,
        type,
        queue: 'media',
        idempotencyKey: randomUUID(),
        maxAttempts,
      })
    ).job;
  });
}

const reload = (id: string) => ds.getRepository(JobEntity).findOneByOrFail({ id });
const attempts = async (id: string) =>
  (
    (await ds.query('SELECT attempt_no, status FROM job_attempts WHERE job_id = $1 ORDER BY attempt_no', [
      id,
    ])) as {
      attempt_no: number;
      status: string;
    }[]
  ).map((a) => `${a.attempt_no}:${a.status}`);
const runStatus = async (runId: string) =>
  ((await ds.query('SELECT status FROM workflow_runs WHERE id = $1', [runId])) as { status: string }[])[0]
    ?.status;

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
  for (const s of stack) await s.close();
  stack = [];
  const q = new QueueSet({ redisUrl, prefix });
  for (const name of QUEUES) await q.get(name).obliterate({ force: true });
  await q.close();
});
afterAll(async () => ds.destroy());

describe('job runner: retry, dead-letter, idempotency (real Postgres + Redis)', () => {
  it('retries a transient failure with backoff and ends succeeded after 3 attempts', async () => {
    await startStack();
    const job = await addJob('test.flaky');
    await expect.poll(async () => (await reload(job.id)).status, { timeout: 10_000 }).toBe('succeeded');
    const done = await reload(job.id);
    expect(done.attempts).toBe(3);
    expect(done.result).toEqual({ calls: 3 });
    expect(done.error).toMatchObject({ message: 'transient failure 2', attempt: 2, fatal: false });
    expect(await attempts(job.id)).toEqual(['1:failed', '2:failed', '3:succeeded']);
    expect(await runStatus(job.workflowRunId)).toBe('succeeded');
  });

  it('sends a fatal error straight to dead and fails the run', async () => {
    await startStack();
    const job = await addJob('test.fatal');
    await expect.poll(async () => (await reload(job.id)).status, { timeout: 10_000 }).toBe('dead');
    const dead = await reload(job.id);
    expect(dead.attempts).toBe(1);
    expect(dead.error).toMatchObject({ message: 'bad input file', name: 'FatalJobError', fatal: true });
    expect(await runStatus(job.workflowRunId)).toBe('failed');
  });

  it('goes to dead after max attempts and keeps the last error', async () => {
    await startStack();
    const job = await addJob('test.always', 2);
    await expect.poll(async () => (await reload(job.id)).status, { timeout: 10_000 }).toBe('dead');
    expect((await reload(job.id)).attempts).toBe(2);
    expect(await attempts(job.id)).toEqual(['1:failed', '2:failed']);
  });

  it('treats a redelivered message for a succeeded job as a no-op', async () => {
    await startStack();
    const job = await addJob('test.count');
    await expect.poll(async () => (await reload(job.id)).status, { timeout: 10_000 }).toBe('succeeded');
    // re-add the BullMQ message (as a redelivery would) under a fresh message id
    const msg = await qs
      .get('media')
      .add('test.count', { jobId: job.id }, { jobId: `${bullJobId(job.id, 1)}-again` });
    await expect.poll(async () => (await msg.getState()) === 'completed', { timeout: 10_000 }).toBe(true);
    expect((await qs.get('media').getJob(msg.id ?? ''))?.returnvalue).toBe('skipped');
    expect(calls.get(job.id)).toBe(1);
    expect((await reload(job.id)).attempts).toBe(1);
  });

  it('lets only one of two concurrent runners execute the same job', async () => {
    const registry = new HandlerRegistry();
    for (const h of handlers) registry.register(h);
    const job = await addJob('test.count');
    await ds.query(`UPDATE jobs SET status = 'queued' WHERE id = $1`, [job.id]);
    const a = new JobRunner(ds, registry, { workerId: 'a' });
    const b = new JobRunner(ds, registry, { workerId: 'b' });
    const outcomes = (await Promise.all([a.run(job.id), b.run(job.id)])).sort();
    expect(outcomes).toEqual(['skipped', 'succeeded']);
    expect(calls.get(job.id)).toBe(1);
  });
});
