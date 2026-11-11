import { EventEmitter } from 'node:events';
import type { Env } from '@myvideo/infra';
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import pg from 'pg';
import { ENV } from '../config/env.module.js';

export type FeedSignal = { id: string; runId: string; merchantId: string };

/**
 * One LISTEN connection per API process for `job_events` (written by DB triggers). Fans notifications out by
 * run id. Notifications are only "something changed" signals; readers fetch rows from the table, so a missed
 * notification is never a lost event.
 */
@Injectable()
export class NotifyHub implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotifyHub.name);
  private readonly bus = new EventEmitter();
  private client: pg.Client | undefined;
  private closing = false;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.bus.setMaxListeners(0);
  }

  async onModuleInit(): Promise<void> {
    await this.connect();
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ connectionString: this.env.DATABASE_URL });
    client.on('notification', (msg) => {
      if (msg.channel !== 'job_events' || !msg.payload) return;
      try {
        const s = JSON.parse(msg.payload) as FeedSignal;
        this.bus.emit(s.runId, s);
      } catch {
        // ignore malformed payloads
      }
    });
    client.on('error', (err) => {
      this.logger.warn(`LISTEN connection lost: ${err.message}`);
      if (!this.closing) setTimeout(() => void this.connect().catch(() => undefined), 1000);
    });
    await client.connect();
    await client.query('LISTEN job_events');
    this.client = client;
  }

  subscribe(runId: string, fn: (s: FeedSignal) => void): () => void {
    this.bus.on(runId, fn);
    return () => this.bus.off(runId, fn);
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    await this.client?.end().catch(() => undefined);
  }
}
