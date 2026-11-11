import { hostname } from 'node:os';
import { backoffMs, deriveRunStatus, type JobStatus } from '@myvideo/domain';
import type { DataSource, EntityManager } from 'typeorm';
import { JobEntity } from '../db/entities/job.entity.js';
import { FatalJobError, type HandlerRegistry, type JobHandler } from './handlers.js';
import { enqueueInTransaction } from './job-store.js';

export type RunOutcome = 'succeeded' | 'retrying' | 'dead' | 'cancelled' | 'skipped';

export const defaultWorkerId = () => `${hostname()}:${process.pid}`;

export type RunnerOptions = {
  workerId?: string;
  backoff?: { baseMs?: number; capMs?: number };
  heartbeatMs?: number;
  /** Minimum time between progress writes. */
  progressThrottleMs?: number;
};

type ErrorDetail = { message: string; name: string; fatal: boolean; attempt: number; at: string };

function errorDetail(err: unknown, attempt: number, fatal: boolean): ErrorDetail {
  const e = err instanceof Error ? err : new Error(String(err));
  return { message: e.message.slice(0, 2000), name: e.name, fatal, attempt, at: new Date().toISOString() };
}

/** Recomputes a run's status from its steps; called in the same transaction as every step change. */
export async function refreshRunStatus(em: EntityManager, workflowRunId: string): Promise<void> {
  const rows: { status: JobStatus }[] = await em.query('SELECT status FROM jobs WHERE workflow_run_id = $1', [
    workflowRunId,
  ]);
  const status = deriveRunStatus(rows.map((r) => r.status));
  const terminal = status === 'succeeded' || status === 'failed' || status === 'cancelled';
  await em.query(
    `UPDATE workflow_runs SET status = $2, updated_at = now(),
            finished_at = CASE WHEN $3 THEN coalesce(finished_at, now()) ELSE NULL END
      WHERE id = $1 AND status IS DISTINCT FROM $2`,
    [workflowRunId, status, terminal],
  );
}

/**
 * Executes one job id taken from a queue (ARCHITECTURE §5.3–5.6):
 * - conditional claim `queued → running` (+ attempt row) — losing the claim means someone else has it or it is
 *   already done, so a redelivered or duplicated message is a no-op;
 * - heartbeat while running; abort on timeout or `cancel_requested`;
 * - outcome written in one transaction, guarded by `status = 'running' AND locked_by = me`, so a stale worker
 *   can never overwrite newer state; the BullMQ message is acked only after that commit (the processor returns).
 */
export class JobRunner {
  private readonly workerId: string;

  constructor(
    private readonly ds: DataSource,
    private readonly handlers: HandlerRegistry,
    private readonly opts: RunnerOptions = {},
  ) {
    this.workerId = opts.workerId ?? defaultWorkerId();
  }

  private async claim(jobId: string): Promise<JobEntity | null> {
    return this.ds.transaction(async (em) => {
      const rows: { id: string; attempts: number; merchant_id: string; workflow_run_id: string }[] = (
        await em.query(
          `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_by = $2, heartbeat_at = now(),
                  started_at = coalesce(started_at, now()), updated_at = now()
            WHERE id = $1 AND status = 'queued' AND cancel_requested = false
            RETURNING id, attempts, merchant_id, workflow_run_id`,
          [jobId, this.workerId],
        )
      )[0];
      const row = rows[0];
      if (!row) return null;
      await em.query(
        `INSERT INTO job_attempts (merchant_id, job_id, attempt_no, worker_id) VALUES ($1, $2, $3, $4)`,
        [row.merchant_id, row.id, row.attempts, this.workerId],
      );
      await refreshRunStatus(em, row.workflow_run_id);
      return em.getRepository(JobEntity).findOneByOrFail({ id: jobId });
    });
  }

  /** Writes the outcome; returns false when this worker no longer owns the job (stale). */
  private async finish(
    job: JobEntity,
    to: 'succeeded' | 'failed' | 'dead' | 'cancelled',
    patch: { result?: unknown; error?: ErrorDetail; runAfter?: Date },
    attemptStatus: 'succeeded' | 'failed' | 'cancelled' | 'timed_out',
    handler?: JobHandler,
  ): Promise<boolean> {
    return this.ds.transaction(async (em) => {
      const res: [unknown[], number] = await em.query(
        `UPDATE jobs SET status = $3, updated_at = now(),
                result = coalesce($4::jsonb, result), error = coalesce($5::jsonb, error),
                progress = CASE WHEN $3 = 'succeeded' THEN 1 ELSE progress END,
                run_after = coalesce($6::timestamptz, run_after),
                locked_by = NULL, heartbeat_at = NULL, queued_at = NULL,
                finished_at = CASE WHEN $3 IN ('succeeded', 'dead', 'cancelled') THEN now() ELSE NULL END
          WHERE id = $1 AND status = 'running' AND locked_by = $2`,
        [
          job.id,
          this.workerId,
          to,
          patch.result === undefined ? null : JSON.stringify(patch.result),
          patch.error ? JSON.stringify(patch.error) : null,
          patch.runAfter ?? null,
        ],
      );
      if (res[1] === 0) return false;
      await em.query(
        `UPDATE job_attempts SET status = $3, error = $4::jsonb, finished_at = now()
          WHERE job_id = $1 AND attempt_no = $2`,
        [job.id, job.attempts, attemptStatus, patch.error ? JSON.stringify(patch.error) : null],
      );
      if (to === 'succeeded' && handler?.next) {
        for (const step of handler.next(job, (patch.result ?? {}) as Record<string, unknown>)) {
          await enqueueInTransaction(em, {
            merchantId: job.merchantId,
            workflowRunId: job.workflowRunId,
            type: step.type,
            queue: step.queue,
            payload: step.payload,
            stepIndex: job.stepIndex + 1,
            idempotencyKey: `${job.workflowRunId}:${step.type}`,
            maxAttempts: step.maxAttempts,
            timeoutMs: step.timeoutMs,
          });
        }
      }
      if (to === 'dead' && handler?.onDead && patch.error) await handler.onDead(em, job, patch.error);
      await refreshRunStatus(em, job.workflowRunId);
      return true;
    });
  }

  async run(jobId: string): Promise<RunOutcome> {
    const job = await this.claim(jobId);
    if (!job) return 'skipped';
    const handler = this.handlers.get(job.type);
    const ac = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      ac.abort(new Error(`job timed out after ${job.timeoutMs} ms`));
    }, job.timeoutMs);
    // Heartbeat keeps the lease; it also notices a cancel request and aborts the handler.
    const heartbeat = setInterval(async () => {
      try {
        const rows: { cancel_requested: boolean }[] = (
          await this.ds.query(
            `UPDATE jobs SET heartbeat_at = now() WHERE id = $1 AND locked_by = $2 AND status = 'running'
              RETURNING cancel_requested`,
            [job.id, this.workerId],
          )
        )[0];
        if (rows[0]?.cancel_requested && !ac.signal.aborted) {
          cancelled = true;
          ac.abort(new Error('job cancelled'));
        }
      } catch {
        // a missed heartbeat is retried on the next tick
      }
    }, this.opts.heartbeatMs ?? 2000);
    let lastProgress = 0;
    const progress = async (value: number) => {
      const now = Date.now();
      if (now - lastProgress < (this.opts.progressThrottleMs ?? 250) && value < 1) return;
      lastProgress = now;
      await this.ds.query(
        `UPDATE jobs SET progress = $3, updated_at = now() WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
        [job.id, this.workerId, Math.max(0, Math.min(1, value))],
      );
    };
    try {
      if (!handler) throw new FatalJobError(`no handler for job type ${job.type}`);
      const result = await handler.run({ job, attempt: job.attempts, signal: ac.signal, progress });
      if (cancelled) throw new Error('job cancelled');
      return (await this.finish(job, 'succeeded', { result: result ?? {} }, 'succeeded', handler))
        ? 'succeeded'
        : 'skipped';
    } catch (err) {
      if (cancelled) {
        await this.finish(job, 'cancelled', { error: errorDetail(err, job.attempts, true) }, 'cancelled');
        return 'cancelled';
      }
      const fatal = err instanceof FatalJobError;
      const detail = errorDetail(err, job.attempts, fatal);
      if (fatal || job.attempts >= job.maxAttempts) {
        await this.finish(job, 'dead', { error: detail }, timedOut ? 'timed_out' : 'failed', handler);
        return 'dead';
      }
      const runAfter = new Date(Date.now() + backoffMs(job.attempts, this.opts.backoff));
      await this.finish(job, 'failed', { error: detail, runAfter }, timedOut ? 'timed_out' : 'failed');
      return 'retrying';
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
    }
  }
}
