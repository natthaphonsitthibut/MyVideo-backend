import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshTestDb } from '../../../test/test-db.js';
import { JobEntity } from '../src/db/entities/job.entity.js';
import { JobAttemptEntity } from '../src/db/entities/job-attempt.entity.js';
import { WorkflowRunEntity } from '../src/db/entities/workflow-run.entity.js';
import { seedMerchant } from '../src/db/seed.js';

describe('jobs schema constraints (real Postgres)', () => {
  let ds: DataSource;
  let a: string;
  let b: string;
  let runA: string;
  const job = (merchantId: string, workflowRunId: string, extra: Record<string, unknown> = {}) => ({
    merchantId,
    workflowRunId,
    type: 'system.sleep',
    queue: 'media' as const,
    idempotencyKey: `k-${Math.random()}`,
    ...extra,
  });

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
    runA = (await ds.getRepository(WorkflowRunEntity).save({ merchantId: a, kind: 'system_test' })).id;
  });
  afterAll(async () => ds.destroy());

  it('creates runs and jobs with safe defaults', async () => {
    const saved = await ds.getRepository(JobEntity).save(job(a, runA));
    const row = await ds.getRepository(JobEntity).findOneByOrFail({ id: saved.id });
    expect(row).toMatchObject({
      status: 'pending',
      attempts: 0,
      maxAttempts: 3,
      progress: 0,
      cancelRequested: false,
    });
    expect(row.runAfter).toBeInstanceOf(Date);
  });

  it('rejects an invalid status, queue, kind and progress', async () => {
    const jobs = ds.getRepository(JobEntity);
    await expect(jobs.insert(job(a, runA, { status: 'done' as never }))).rejects.toThrow(/jobs_status_valid/);
    await expect(jobs.insert(job(a, runA, { queue: 'gpu' as never }))).rejects.toThrow(/jobs_queue_valid/);
    await expect(jobs.insert(job(a, runA, { progress: 1.5 }))).rejects.toThrow(/jobs_progress_valid/);
    await expect(jobs.insert(job(a, runA, { attempts: 4, maxAttempts: 3 }))).rejects.toThrow(
      /jobs_attempts_valid/,
    );
    await expect(
      ds.getRepository(WorkflowRunEntity).insert({ merchantId: a, kind: 'nope' as never }),
    ).rejects.toThrow(/workflow_runs_kind_valid/);
    await expect(
      ds
        .getRepository(WorkflowRunEntity)
        .insert({ merchantId: a, kind: 'system_test', status: 'done' as never }),
    ).rejects.toThrow(/workflow_runs_status_valid/);
  });

  it('rejects a duplicate idempotency key for the same merchant only', async () => {
    const jobs = ds.getRepository(JobEntity);
    await jobs.insert(job(a, runA, { idempotencyKey: 'ingest:source-1' }));
    await expect(jobs.insert(job(a, runA, { idempotencyKey: 'ingest:source-1' }))).rejects.toThrow(
      /jobs_merchant_idempotency_key/,
    );
    const runB = (await ds.getRepository(WorkflowRunEntity).save({ merchantId: b, kind: 'system_test' })).id;
    await expect(jobs.insert(job(b, runB, { idempotencyKey: 'ingest:source-1' }))).resolves.toBeTruthy();
  });

  it('keeps one attempt row per attempt number and cascades with the job', async () => {
    const j = await ds.getRepository(JobEntity).save(job(a, runA));
    const attempts = ds.getRepository(JobAttemptEntity);
    await attempts.insert({ merchantId: a, jobId: j.id, attemptNo: 1, workerId: 'w1' });
    await expect(
      attempts.insert({ merchantId: a, jobId: j.id, attemptNo: 1, workerId: 'w2' }),
    ).rejects.toThrow(/job_attempts_job_attempt_key/);
    await expect(
      attempts.insert({ merchantId: a, jobId: j.id, attemptNo: 2, workerId: 'w1', status: 'meh' as never }),
    ).rejects.toThrow(/job_attempts_status_valid/);
    await ds.getRepository(WorkflowRunEntity).delete(runA);
    expect(await attempts.countBy({ jobId: j.id })).toBe(0);
    expect(await ds.getRepository(JobEntity).countBy({ workflowRunId: runA })).toBe(0);
  });
});
