import type { QueueName } from '@myvideo/domain';
import type { JobEntity } from '../db/entities/job.entity.js';

export type JobContext = {
  job: JobEntity;
  attempt: number;
  /** Aborted on cancel or timeout; long work must pass it on (child processes, fetch). */
  signal: AbortSignal;
  /** Throttled progress report, 0..1. */
  progress: (value: number) => Promise<void>;
};

export interface JobHandler {
  readonly type: string;
  readonly queue: QueueName;
  run(ctx: JobContext): Promise<Record<string, unknown> | undefined>;
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
    run: async ({ job, signal, progress }) => {
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
