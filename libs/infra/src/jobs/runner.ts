import { hostname } from 'node:os';
import type { DataSource } from 'typeorm';
import { JobEntity } from '../db/entities/job.entity.js';
import type { HandlerRegistry } from './handlers.js';

export type RunOutcome = 'succeeded' | 'failed' | 'skipped';

export const defaultWorkerId = () => `${hostname()}:${process.pid}`;

/**
 * Executes one job id taken from a queue. The conditional claim (`queued → running`) is the guard that makes
 * redelivery and double dispatch harmless: whoever loses the claim does nothing.
 */
export class JobRunner {
  constructor(
    private readonly ds: DataSource,
    private readonly handlers: HandlerRegistry,
    private readonly workerId: string = defaultWorkerId(),
  ) {}

  async run(jobId: string): Promise<RunOutcome> {
    const claimed: [JobEntity[], number] = await this.ds.query(
      `UPDATE jobs SET status = 'running', locked_by = $2, heartbeat_at = now(), started_at = coalesce(started_at, now()),
              updated_at = now()
        WHERE id = $1 AND status = 'queued' RETURNING id`,
      [jobId, this.workerId],
    );
    if (claimed[1] === 0) return 'skipped';
    const job = await this.ds.getRepository(JobEntity).findOneByOrFail({ id: jobId });
    const handler = this.handlers.get(job.type);
    try {
      if (!handler) throw new Error(`no handler for job type ${job.type}`);
      const ac = new AbortController();
      const result = await handler.run({
        job,
        attempt: job.attempts + 1,
        signal: ac.signal,
        progress: async () => {},
      });
      await this.ds.query(
        `UPDATE jobs SET status = 'succeeded', progress = 1, result = $2, finished_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'running'`,
        [jobId, JSON.stringify(result ?? {})],
      );
      return 'succeeded';
    } catch (err) {
      await this.ds.query(
        `UPDATE jobs SET status = 'dead', error = $2, finished_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'running'`,
        [jobId, JSON.stringify({ message: err instanceof Error ? err.message : String(err) })],
      );
      return 'failed';
    }
  }
}
