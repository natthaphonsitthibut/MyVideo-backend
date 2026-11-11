import { Redis } from 'ioredis';
import pg from 'pg';

export type ProbeResult = { status: 'up' | 'down'; latencyMs: number; error?: string };

function errorMessage(err: unknown): string {
  if (err instanceof AggregateError && err.errors.length > 0) return errorMessage(err.errors[0]);
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

async function timed(fn: () => Promise<void>): Promise<ProbeResult> {
  const started = performance.now();
  try {
    await fn();
    return { status: 'up', latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    return { status: 'down', latencyMs: Math.round(performance.now() - started), error: errorMessage(err) };
  }
}

/** Opens a short-lived connection and runs `SELECT 1`. Never throws. */
export function probePostgres(url: string, timeoutMs = 2000): Promise<ProbeResult> {
  return timed(async () => {
    const client = new pg.Client({
      connectionString: url,
      connectionTimeoutMillis: timeoutMs,
      query_timeout: timeoutMs,
    });
    try {
      await client.connect();
      await client.query('SELECT 1');
    } finally {
      await client.end().catch(() => undefined);
    }
  });
}

/** Opens a short-lived connection and sends PING. Never throws, never retries. */
export function probeRedis(url: string, timeoutMs = 2000): Promise<ProbeResult> {
  return timed(async () => {
    const client = new Redis(url, {
      lazyConnect: true,
      connectTimeout: timeoutMs,
      commandTimeout: timeoutMs,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    client.on('error', () => undefined);
    try {
      await client.connect();
      const pong = await client.ping();
      if (pong !== 'PONG') throw new Error(`unexpected reply: ${pong}`);
    } finally {
      client.disconnect();
    }
  });
}
