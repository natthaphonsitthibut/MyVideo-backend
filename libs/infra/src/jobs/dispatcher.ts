import type { QueueName } from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import { bullJobId, type QueueSet } from './queues.js';

export type DispatcherOptions = {
  batchSize?: number;
  pollMs?: number;
  /** A `queued` row older than this whose BullMQ message is missing goes back to `pending`. */
  lostAfterMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
};

type Claimed = { id: string; queue: QueueName; type: string; attempts: number };

/**
 * Outbox dispatcher (ARCHITECTURE §5.2). Phase 1 (one short transaction): lock due `pending` rows with
 * `FOR UPDATE SKIP LOCKED` and mark them `queued` — two dispatchers never take the same row. Phase 2:
 * add one BullMQ message per row. A crash between the phases leaves `queued` rows without a message;
 * `recoverLost()` returns them to `pending` after `lostAfterMs`. Nothing is lost, nothing runs twice
 * (the worker's conditional claim is the second guard).
 */
export class Dispatcher {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = true;
  private readonly batchSize: number;
  private readonly pollMs: number;
  private readonly lostAfterMs: number;

  constructor(
    private readonly ds: DataSource,
    private readonly queues: QueueSet,
    private readonly opts: DispatcherOptions = {},
  ) {
    this.batchSize = opts.batchSize ?? 50;
    this.pollMs = opts.pollMs ?? 500;
    this.lostAfterMs = opts.lostAfterMs ?? 30_000;
  }

  /** Marks due pending rows queued and commits; returns them. Exposed for crash tests. */
  async claimDue(): Promise<Claimed[]> {
    return this.ds.transaction(async (em) => {
      // retryable failures whose backoff has passed become dispatchable again (failed → pending)
      await em.query(
        `UPDATE jobs SET status = 'pending', updated_at = now()
          WHERE status = 'failed' AND run_after <= now() AND cancel_requested = false`,
      );
      const rows: Claimed[] = await em.query(
        `SELECT id, queue, type, attempts FROM jobs
          WHERE status = 'pending' AND run_after <= now()
          ORDER BY run_after, id
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [this.batchSize],
      );
      if (rows.length === 0) return [];
      await em.query(
        `UPDATE jobs SET status = 'queued', queued_at = now(), updated_at = now()
          WHERE id = ANY($1::uuid[]) AND status = 'pending'`,
        [rows.map((r) => r.id)],
      );
      return rows;
    });
  }

  async publish(rows: Claimed[]): Promise<void> {
    for (const r of rows) {
      await this.queues.get(r.queue).add(r.type, { jobId: r.id }, { jobId: bullJobId(r.id, r.attempts) });
    }
  }

  /** One dispatch pass. Returns how many jobs were handed to the queues. */
  async tick(): Promise<number> {
    const rows = await this.claimDue();
    await this.publish(rows);
    return rows.length;
  }

  /** `queued` rows whose message is gone (crash between phases, Redis flushed) → back to `pending`. */
  async recoverLost(): Promise<number> {
    const stale: Claimed[] = await this.ds.query(
      `SELECT id, queue, type, attempts FROM jobs
        WHERE status = 'queued' AND queued_at < now() - ($1 || ' milliseconds')::interval
        LIMIT 200`,
      [String(this.lostAfterMs)],
    );
    let recovered = 0;
    for (const r of stale) {
      const msg = await this.queues.get(r.queue).getJob(bullJobId(r.id, r.attempts));
      if (msg) continue;
      const res: [unknown[], number] = await this.ds.query(
        `UPDATE jobs SET status = 'pending', queued_at = NULL, updated_at = now()
          WHERE id = $1 AND status = 'queued'`,
        [r.id],
      );
      recovered += res[1];
    }
    if (recovered > 0) this.opts.log?.('recovered lost queued jobs', { recovered });
    return recovered;
  }

  start(): void {
    this.stopped = false;
    let passes = 0;
    const loop = async () => {
      if (this.stopped) return;
      this.running = true;
      try {
        while ((await this.tick()) === this.batchSize && !this.stopped) {
          // drain backlog in batches
        }
        if (++passes % 20 === 0) await this.recoverLost();
      } catch (err) {
        this.opts.log?.('dispatch failed', { error: err instanceof Error ? err.message : String(err) });
      } finally {
        this.running = false;
        if (!this.stopped) this.timer = setTimeout(loop, this.pollMs);
      }
    };
    void loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 10));
  }
}
