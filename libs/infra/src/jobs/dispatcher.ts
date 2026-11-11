import type { QueueName } from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import { bullJobId, type QueueSet } from './queues.js';

export type DispatcherOptions = {
  batchSize?: number;
  pollMs?: number;
  /** A `queued` row older than this whose BullMQ message is missing goes back to `pending`. */
  lostAfterMs?: number;
  /** A `running` row whose heartbeat is older than this lost its worker → back to the queue. */
  staleAfterMs?: number;
  /** Max queued+running jobs per merchant (fairness). */
  maxInflightPerMerchant?: number;
  /** Run the recovery passes every N dispatch passes. */
  recoverEvery?: number;
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
  private readonly staleAfterMs: number;
  private readonly maxInflight: number;
  private readonly recoverEvery: number;

  constructor(
    private readonly ds: DataSource,
    private readonly queues: QueueSet,
    private readonly opts: DispatcherOptions = {},
  ) {
    this.batchSize = opts.batchSize ?? 50;
    this.pollMs = opts.pollMs ?? 500;
    this.lostAfterMs = opts.lostAfterMs ?? 30_000;
    this.staleAfterMs = opts.staleAfterMs ?? 30_000;
    this.maxInflight = opts.maxInflightPerMerchant ?? Number.MAX_SAFE_INTEGER;
    this.recoverEvery = opts.recoverEvery ?? 20;
  }

  /** Marks due pending rows queued and commits; returns them. Exposed for crash tests. */
  async claimDue(): Promise<Claimed[]> {
    return this.ds.transaction(async (em) => {
      // retryable failures whose backoff has passed become dispatchable again (failed → pending)
      await em.query(
        `UPDATE jobs SET status = 'pending', updated_at = now()
          WHERE status = 'failed' AND run_after <= now() AND cancel_requested = false`,
      );
      const candidates: (Claimed & { merchant_id: string })[] = await em.query(
        `SELECT id, queue, type, attempts, merchant_id FROM jobs
          WHERE status = 'pending' AND run_after <= now()
          ORDER BY run_after, id
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [this.batchSize],
      );
      if (candidates.length === 0) return [];
      // Fairness: never more than maxInflight queued+running jobs per merchant; the rest wait their turn.
      const merchants = [...new Set(candidates.map((c) => c.merchant_id))];
      const inflight: { merchant_id: string; n: string }[] = await em.query(
        `SELECT merchant_id, count(*) AS n FROM jobs
          WHERE merchant_id = ANY($1::uuid[]) AND status IN ('queued', 'running') GROUP BY merchant_id`,
        [merchants],
      );
      const room = new Map(merchants.map((m) => [m, this.maxInflight]));
      for (const r of inflight) room.set(r.merchant_id, this.maxInflight - Number(r.n));
      const rows: Claimed[] = [];
      for (const c of candidates) {
        const left = room.get(c.merchant_id) ?? 0;
        if (left <= 0) continue;
        room.set(c.merchant_id, left - 1);
        rows.push({ id: c.id, queue: c.queue, type: c.type, attempts: c.attempts });
      }
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

  /**
   * Abandoned leases: a `running` job whose worker stopped heartbeating (killed, OOM, machine slept) goes back
   * to `queued` with `queued_at` in the past, so `recoverLost` re-dispatches it at once if no message exists.
   * The old attempt is closed as failed. A late write from the dead worker is rejected by the lock guard.
   */
  async reapStale(): Promise<number> {
    return this.ds.transaction(async (em) => {
      const res: [{ id: string; attempts: number }[], number] = await em.query(
        `UPDATE jobs SET status = 'queued', locked_by = NULL, heartbeat_at = NULL,
                queued_at = now() - interval '1 day', updated_at = now()
          WHERE status = 'running' AND heartbeat_at < now() - ($1 || ' milliseconds')::interval
          RETURNING id, attempts`,
        [String(this.staleAfterMs)],
      );
      for (const r of res[0]) {
        await em.query(
          `UPDATE job_attempts SET status = 'failed', finished_at = now(),
                  error = '{"message":"worker lost (heartbeat expired)","name":"WorkerLost"}'::jsonb
            WHERE job_id = $1 AND attempt_no = $2 AND status = 'running'`,
          [r.id, r.attempts],
        );
      }
      if (res[0].length > 0) this.opts.log?.('reaped abandoned jobs', { reaped: res[0].length });
      return res[0].length;
    });
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
        if (++passes % this.recoverEvery === 0) {
          await this.reapStale();
          await this.recoverLost();
        }
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
