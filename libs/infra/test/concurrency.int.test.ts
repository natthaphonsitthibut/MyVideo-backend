import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshTestDb } from '../../../test/test-db.js';
import { testEnv } from '../../../test/test-env.js';
import { JobEntity } from '../src/db/entities/job.entity.js';
import { seedMerchant } from '../src/db/seed.js';
import { Dispatcher } from '../src/jobs/dispatcher.js';
import {
  assertRunCapacity,
  createRunInTransaction,
  enqueueInTransaction,
  RunCapacityError,
} from '../src/jobs/job-store.js';
import { QueueSet } from '../src/jobs/queues.js';

let ds: DataSource;
let a: string;
let b: string;
beforeAll(async () => {
  ds = await freshTestDb();
  a = (
    await seedMerchant(ds, {
      merchantName: 'A',
      merchantSlug: 'shop-a',
      email: 'a@a.local',
      password: 'password-a',
      displayName: 'A',
    })
  ).merchant.id;
  b = (
    await seedMerchant(ds, {
      merchantName: 'B',
      merchantSlug: 'shop-b',
      email: 'b@b.local',
      password: 'password-b',
      displayName: 'B',
    })
  ).merchant.id;
});
afterAll(async () => ds.destroy());

describe('concurrency (real Postgres)', () => {
  it('ten concurrent requests with one idempotency key create one job', async () => {
    const run = await ds.transaction((em) =>
      createRunInTransaction(em, { merchantId: a, kind: 'system_test' }),
    );
    const key = `upload:${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        ds.transaction((em) =>
          enqueueInTransaction(em, {
            merchantId: a,
            workflowRunId: run.id,
            type: 'system.noop',
            queue: 'media',
            idempotencyKey: key,
          }),
        ),
      ),
    );
    expect(new Set(results.map((r) => r.job.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await ds.getRepository(JobEntity).countBy({ idempotencyKey: key })).toBe(1);
  });

  it('caps queued+running jobs per merchant; extra jobs wait, other merchants are not blocked', async () => {
    await ds.query('TRUNCATE workflow_runs CASCADE');
    const add = (merchantId: string) =>
      ds.transaction(async (em) => {
        const run = await createRunInTransaction(em, { merchantId, kind: 'system_test' });
        return (
          await enqueueInTransaction(em, {
            merchantId,
            workflowRunId: run.id,
            type: 'system.noop',
            queue: 'media',
            idempotencyKey: randomUUID(),
          })
        ).job.id;
      });
    const aJobs = [await add(a), await add(a), await add(a)];
    const bJob = await add(b);
    const prefix = `test-${randomUUID().slice(0, 8)}`;
    const qs = new QueueSet({ redisUrl: testEnv().REDIS_URL, prefix });
    const d = new Dispatcher(ds, qs, { maxInflightPerMerchant: 1 });
    expect(await d.tick()).toBe(2); // one of A, one of B
    expect(await d.tick()).toBe(0); // A still has one in flight
    const statusOf = async (ids: string[]) =>
      (await ds.getRepository(JobEntity).findBy(ids.map((id) => ({ id })))).map((j) => j.status).sort();
    expect(await statusOf(aJobs)).toEqual(['pending', 'pending', 'queued']);
    expect(await statusOf([bJob])).toEqual(['queued']);
    // the in-flight A job finishes → the next one may go
    await ds.query(`UPDATE jobs SET status = 'running' WHERE merchant_id = $1 AND status = 'queued'`, [a]);
    await ds.query(`UPDATE jobs SET status = 'succeeded' WHERE merchant_id = $1 AND status = 'running'`, [a]);
    expect(await d.tick()).toBe(1);
    expect(await statusOf(aJobs)).toEqual(['pending', 'queued', 'succeeded']);
    for (const q of ['media', 'ai', 'render'] as const) await qs.get(q).obliterate({ force: true });
    await qs.close();
  });

  it('refuses runs beyond the active-run limit, counting concurrent requests one by one', async () => {
    await ds.query('TRUNCATE workflow_runs CASCADE');
    const create = () =>
      ds.transaction(async (em) => {
        await assertRunCapacity(em, a, 2);
        return createRunInTransaction(em, { merchantId: a, kind: 'system_test' });
      });
    const results = await Promise.allSettled(Array.from({ length: 6 }, create));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(4);
    for (const r of rejected) expect(r.reason).toBeInstanceOf(RunCapacityError);
    // another merchant is unaffected
    await expect(ds.transaction((em) => assertRunCapacity(em, b, 2))).resolves.toBeUndefined();
  });
});
