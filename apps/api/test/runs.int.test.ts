import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { QUEUES } from '@myvideo/domain';
import {
  Dispatcher,
  HandlerRegistry,
  JobRunner,
  QueueSet,
  QueueWorkers,
  seedMerchant,
  systemHandlers,
} from '@myvideo/infra';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshTestDb } from '../../../test/test-db.js';
import { testEnv } from '../../../test/test-env.js';
import { createApp } from '../src/app.js';
import { loginCookie } from './helpers.js';

const A = {
  merchantName: 'A',
  merchantSlug: 'shop-a',
  email: 'a@a.local',
  password: 'password-a',
  displayName: 'A',
};
const B = {
  merchantName: 'B',
  merchantSlug: 'shop-b',
  email: 'b@b.local',
  password: 'password-b',
  displayName: 'B',
};
type Ev = { event: string; id?: string; data: Record<string, unknown> };

/** Reads an SSE response until `end` (or `max` events), parsing `event`, `id`, `data`. */
async function readSse(res: Response, max = 1000): Promise<Ev[]> {
  const out: Ev[] = [];
  const reader = res.body?.getReader();
  if (!reader) throw new Error('no body');
  const dec = new TextDecoder();
  let buf = '';
  while (out.length < max) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i = buf.indexOf('\n\n');
    while (i >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      i = buf.indexOf('\n\n');
      const ev: Ev = { event: 'message', data: {} };
      let hasData = false;
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) ev.event = line.slice(7);
        else if (line.startsWith('id: ')) ev.id = line.slice(4);
        else if (line.startsWith('data: ')) {
          ev.data = JSON.parse(line.slice(6));
          hasData = true;
        }
      }
      if (hasData) out.push(ev);
      if (ev.event === 'end' || out.length >= max) {
        await reader.cancel();
        return out;
      }
    }
  }
  return out;
}

describe('workflow runs + SSE progress (real Postgres + Redis)', () => {
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let cookieA: string;
  let cookieB: string;
  const prefix = `test-${randomUUID().slice(0, 8)}`;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    ds = await freshTestDb();
    await seedMerchant(ds, A);
    await seedMerchant(ds, B);
    app = await createApp(testEnv());
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    cookieA = await loginCookie(app, A.email, A.password);
    cookieB = await loginCookie(app, B.email, B.password);
    const redisUrl = testEnv().REDIS_URL;
    const qs = new QueueSet({ redisUrl, prefix });
    const registry = new HandlerRegistry();
    for (const h of systemHandlers) registry.register(h);
    const workers = new QueueWorkers(
      { redisUrl, prefix, concurrency: { media: 1, ai: 1, render: 1 } },
      new JobRunner(ds, registry, { workerId: 'w-sse', progressThrottleMs: 0, heartbeatMs: 200 }),
    );
    const d = new Dispatcher(ds, qs, { pollMs: 25 });
    workers.start(['media']);
    d.start();
    stop = async () => {
      await d.stop();
      await workers.close();
      for (const q of QUEUES) await qs.get(q).obliterate({ force: true });
      await qs.close();
    };
  });
  afterAll(async () => {
    await stop();
    await app.close();
    await ds.destroy();
  });

  const api = (path: string, cookie: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { cookie, 'content-type': 'application/json', ...init.headers },
    });

  it('streams ordered progress events and then a terminal run event', async () => {
    const created = await api('/workflow-runs/test', cookieA, {
      method: 'POST',
      body: JSON.stringify({ ms: 600, steps: 4 }),
    });
    expect(created.status).toBe(201);
    const run = (await created.json()) as { id: string };
    const res = await api(`/workflow-runs/${run.id}/events`, cookieA);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const events = await readSse(res);
    const ids = events.filter((e) => e.id).map((e) => Number(e.id));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    const progress = events.filter((e) => e.event === 'job').map((e) => e.data.progress as number);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.some((p) => p > 0 && p < 1)).toBe(true);
    const runEvents = events.filter((e) => e.event === 'run').map((e) => e.data.status);
    expect(runEvents.at(-1)).toBe('succeeded');
    expect(events.at(-1)?.event).toBe('end');
  });

  it('replays only events after Last-Event-ID on reconnect', async () => {
    const run = (await (
      await api('/workflow-runs/test', cookieA, {
        method: 'POST',
        body: JSON.stringify({ ms: 300, steps: 2 }),
      })
    ).json()) as { id: string };
    const all = await readSse(await api(`/workflow-runs/${run.id}/events`, cookieA));
    const cut = all[2]?.id ?? '0';
    const rest = await readSse(
      await api(`/workflow-runs/${run.id}/events`, cookieA, { headers: { 'last-event-id': cut } }),
    );
    expect(rest.filter((e) => e.id).map((e) => e.id)).toEqual(
      all.filter((e) => e.id && Number(e.id) > Number(cut)).map((e) => e.id),
    );
  });

  it('lists and reads runs for the owner only', async () => {
    const list = (await (await api('/workflow-runs?limit=1', cookieA)).json()) as {
      items: { id: string; jobs: unknown[] }[];
      nextCursor: string;
    };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.jobs).toHaveLength(1);
    const next = (await (
      await api(`/workflow-runs?limit=1&before=${encodeURIComponent(list.nextCursor)}`, cookieA)
    ).json()) as { items: { id: string }[] };
    expect(next.items[0]?.id).not.toBe(list.items[0]?.id);
    const runId = list.items[0]?.id;
    expect((await api(`/workflow-runs/${runId}`, cookieB)).status).toBe(404);
    expect((await api(`/workflow-runs/${runId}/events`, cookieB)).status).toBe(404);
    expect(
      ((await (await api('/workflow-runs', cookieB)).json()) as { items: unknown[] }).items,
    ).toHaveLength(0);
  });
});
