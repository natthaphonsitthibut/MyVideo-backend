import { randomUUID } from 'node:crypto';
import {
  createRunInTransaction,
  enqueueInTransaction,
  JobEntity,
  QueueSet,
  seedMerchant,
} from '@myvideo/infra';
import type { INestApplicationContext } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshTestDb } from '../../../test/test-db.js';
import { testEnv } from '../../../test/test-env.js';
import { createWorker } from '../src/app.js';

describe('worker app (real Postgres + Redis)', () => {
  let ds: DataSource;
  let worker: INestApplicationContext;
  const prefix = `test-${randomUUID().slice(0, 8)}`;
  beforeAll(async () => {
    ds = await freshTestDb();
    worker = await createWorker(testEnv({ QUEUE_PREFIX: prefix }));
  });
  afterAll(async () => {
    await worker.close();
    const qs = new QueueSet({ redisUrl: testEnv().REDIS_URL, prefix });
    await qs.get('media').obliterate({ force: true });
    await qs.close();
    await ds.destroy();
  });

  it('runs a system.sleep job end to end and records the result', async () => {
    const { merchant } = await seedMerchant(ds, {
      merchantName: 'A',
      merchantSlug: 'shop-a',
      email: 'a@a.local',
      password: 'password-a',
      displayName: 'A',
    });
    const jobId = await ds.transaction(async (em) => {
      const run = await createRunInTransaction(em, { merchantId: merchant.id, kind: 'system_test' });
      return (
        await enqueueInTransaction(em, {
          merchantId: merchant.id,
          workflowRunId: run.id,
          type: 'system.sleep',
          queue: 'media',
          idempotencyKey: randomUUID(),
          payload: { ms: 300, steps: 3 },
        })
      ).job.id;
    });
    await expect
      .poll(async () => (await ds.getRepository(JobEntity).findOneByOrFail({ id: jobId })).status, {
        timeout: 10_000,
      })
      .toBe('succeeded');
    const job = await ds.getRepository(JobEntity).findOneByOrFail({ id: jobId });
    expect(job.result).toEqual({ sleptMs: 300 });
    expect(job.lockedBy).toBeNull();
    const attempts: { worker_id: string; status: string }[] = await ds.query(
      'SELECT worker_id, status FROM job_attempts WHERE job_id = $1',
      [jobId],
    );
    expect(attempts).toEqual([{ worker_id: expect.stringMatching(/:\d+$/), status: 'succeeded' }]);
    const run: { status: string }[] = await ds.query('SELECT status FROM workflow_runs WHERE id = $1', [
      job.workflowRunId,
    ]);
    expect(run[0]?.status).toBe('succeeded');
  });
});
