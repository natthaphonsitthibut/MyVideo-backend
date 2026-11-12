import type { QueueName } from '@myvideo/domain';
import type { EntityManager } from 'typeorm';
import type { JobEntity } from '../db/entities/job.entity.js';

export type JobContext = {
  job: JobEntity;
  attempt: number;
  /** Aborted on cancel or timeout; long work must pass it on (child processes, fetch). */
  signal: AbortSignal;
  /** Throttled progress report, 0..1. */
  progress: (value: number) => Promise<void>;
};

/** The next step of a pipeline, inserted in the same transaction that marks this step succeeded. */
export type NextStep = {
  type: string;
  queue: QueueName;
  payload: Record<string, unknown>;
  /** Distinguishes several steps of the same type in one run (fan-out, e.g. one per chunk). */
  key?: string;
  maxAttempts?: number;
  timeoutMs?: number;
};

export interface JobHandler {
  readonly type: string;
  readonly queue: QueueName;
  run(ctx: JobContext): Promise<Record<string, unknown> | undefined>;
  /**
   * Steps that follow a success (ARCHITECTURE §5.9: pipelines are step lists, not nested jobs). Runs inside the
   * transaction that marks this job succeeded, so a fan-in step can check its siblings there; steps are
   * idempotent per (run, type, key), so two siblings both emitting the same follow-up create it once.
   */
  next?(job: JobEntity, result: Record<string, unknown>, em: EntityManager): NextStep[] | Promise<NextStep[]>;
  /** Called inside the transaction that marks the job dead (e.g. to show a failure on the source). */
  onDead?(em: EntityManager, job: JobEntity, error: { message: string; fatal: boolean }): Promise<void>;
}

/** Thrown for errors that a retry cannot fix (invalid input, unsupported media): the job goes to `dead`. */
export class FatalJobError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FatalJobError';
  }
}

export class HandlerRegistry {
  private readonly byType = new Map<string, JobHandler>();

  register(handler: JobHandler): this {
    if (this.byType.has(handler.type)) throw new Error(`duplicate job handler ${handler.type}`);
    this.byType.set(handler.type, handler);
    return this;
  }

  get(type: string): JobHandler | undefined {
    return this.byType.get(type);
  }

  queues(): QueueName[] {
    return [...new Set([...this.byType.values()].map((h) => h.queue))];
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** Test/diagnostic handlers (`system_test` runs). */
export const systemHandlers: JobHandler[] = [
  { type: 'system.noop', queue: 'media', run: async () => ({ ok: true }) },
  {
    type: 'system.sleep',
    queue: 'media',
    run: async ({ job, attempt, signal, progress }) => {
      if (job.payload.failFirstAttempt === true && attempt === 1)
        throw new FatalJobError('simulated failure (test run)');
      const total = Number(job.payload.ms ?? 1000);
      const steps = Math.max(1, Number(job.payload.steps ?? 10));
      for (let i = 1; i <= steps; i++) {
        await sleep(total / steps, signal);
        await progress(i / steps);
      }
      return { sleptMs: total };
    },
  },
];
