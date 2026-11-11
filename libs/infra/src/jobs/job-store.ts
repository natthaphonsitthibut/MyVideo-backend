import type { QueueName, WorkflowKind } from '@myvideo/domain';
import type { EntityManager } from 'typeorm';
import { JobEntity } from '../db/entities/job.entity.js';
import { WorkflowRunEntity } from '../db/entities/workflow-run.entity.js';

export type NewRun = {
  merchantId: string;
  kind: WorkflowKind;
  subjectType?: string;
  subjectId?: string;
  input?: Record<string, unknown>;
};

export type NewJob = {
  merchantId: string;
  workflowRunId: string;
  type: string;
  queue: QueueName;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
  stepIndex?: number;
  maxAttempts?: number;
  timeoutMs?: number;
  runAfter?: Date;
};

export class RunCapacityError extends Error {
  constructor(readonly limit: number) {
    super(`too many unfinished runs (limit ${limit})`);
    this.name = 'RunCapacityError';
  }
}

/**
 * Back-pressure (ARCHITECTURE §5.7): refuses a new run when the merchant already has `limit` unfinished runs.
 * Locks the merchant row so concurrent requests are counted one after another.
 */
export async function assertRunCapacity(em: EntityManager, merchantId: string, limit: number): Promise<void> {
  await em.query('SELECT id FROM merchants WHERE id = $1 FOR UPDATE', [merchantId]);
  const rows: { n: string }[] = await em.query(
    `SELECT count(*) AS n FROM workflow_runs WHERE merchant_id = $1 AND status IN ('pending', 'running')`,
    [merchantId],
  );
  if (Number(rows[0]?.n ?? 0) >= limit) throw new RunCapacityError(limit);
}

/** Creates a workflow run row. Call inside the caller's transaction. */
export async function createRunInTransaction(em: EntityManager, run: NewRun): Promise<WorkflowRunEntity> {
  return em.getRepository(WorkflowRunEntity).save({
    merchantId: run.merchantId,
    kind: run.kind,
    subjectType: run.subjectType ?? null,
    subjectId: run.subjectId ?? null,
    input: run.input ?? {},
  });
}

/**
 * Outbox write (ARCHITECTURE §5.2): inserts the job row in the caller's transaction, so the domain change and
 * the job commit or roll back together. Idempotent per (merchant, idempotency key): a duplicate returns the
 * existing row with `created: false` instead of failing.
 */
export async function enqueueInTransaction(
  em: EntityManager,
  job: NewJob,
): Promise<{ job: JobEntity; created: boolean }> {
  const inserted = await em
    .createQueryBuilder()
    .insert()
    .into(JobEntity)
    .values({
      merchantId: job.merchantId,
      workflowRunId: job.workflowRunId,
      type: job.type,
      queue: job.queue,
      idempotencyKey: job.idempotencyKey,
      payload: (job.payload ?? {}) as never,
      stepIndex: job.stepIndex ?? 0,
      maxAttempts: job.maxAttempts ?? 3,
      timeoutMs: job.timeoutMs ?? 600_000,
      runAfter: job.runAfter ?? (() => 'now()'),
    })
    .orIgnore()
    .returning(['id'])
    .execute();
  const created = inserted.raw.length > 0;
  const row = await em
    .getRepository(JobEntity)
    .findOneByOrFail({ merchantId: job.merchantId, idempotencyKey: job.idempotencyKey });
  return { job: row, created };
}
