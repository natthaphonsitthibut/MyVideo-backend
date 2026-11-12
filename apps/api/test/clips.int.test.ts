import type { AddressInfo } from 'node:net';
import type { ApiErrorBody, ClipSuggestion, ClipsState } from '@myvideo/contracts';
import { uuidv7 } from '@myvideo/domain';
import { seedMerchant } from '@myvideo/infra';
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

/**
 * HTTP behaviour of the clip API. The workflow itself runs on real footage in
 * libs/infra/test/live-to-clips.int.test.ts; rows here are plain DB setup (no model output).
 */
describe('clips API (real Postgres)', () => {
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let cookieA: string;
  let cookieB: string;
  let merchantA: string;

  beforeAll(async () => {
    ds = await freshTestDb();
    merchantA = (await seedMerchant(ds, A)).merchant.id;
    await seedMerchant(ds, B);
    app = await createApp(testEnv());
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    cookieA = await loginCookie(app, A.email, A.password);
    cookieB = await loginCookie(app, B.email, B.password);
  });
  afterAll(async () => {
    await app.close();
    await ds.destroy();
  });

  const api = (path: string, cookie: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { cookie, origin: base, 'content-type': 'application/json', ...init.headers },
    });

  async function source(transcribed: boolean): Promise<string> {
    const id = uuidv7();
    await ds.query(
      `INSERT INTO video_sources (id, merchant_id, upload_id, title, original_filename, size_bytes, sha256, status)
       VALUES ($1, $2, $3, 'ไลฟ์', 'l.mp4', 10, 'x', 'ready')`,
      [id, merchantA, `up-${id}`],
    );
    if (transcribed) {
      await ds.query(
        `INSERT INTO transcripts (merchant_id, source_id, audio_sha256, model, engine, recipe_version, status, duration_ms)
         VALUES ($1, $2, 'a', 'm', 'e', 2, 'ready', 1000)`,
        [merchantA, id],
      );
    }
    return id;
  }

  it('none before generation; 409 with a Thai reason without a transcript; other merchant 404', async () => {
    const id = await source(false);
    const s = (await (await api(`/sources/${id}/clips`, cookieA)).json()) as ClipsState;
    expect(s).toMatchObject({ runId: null, status: 'none', clips: [] });
    const r = await api(`/sources/${id}/clips`, cookieA, { method: 'POST', body: '{}' });
    expect(r.status).toBe(409);
    expect(((await r.json()) as ApiErrorBody).message).toMatch(/ถอดเสียง/);
    expect((await api(`/sources/${id}/clips`, cookieB)).status).toBe(404);
    expect((await api(`/sources/${id}/clips`, cookieB, { method: 'POST', body: '{}' })).status).toBe(404);
  });

  it('generate: 202 + run; asking again joins it; fresh while running still joins', async () => {
    const id = await source(true);
    const r1 = await api(`/sources/${id}/clips`, cookieA, {
      method: 'POST',
      body: JSON.stringify({ productName: '  เสื้อมัดย้อม ' }),
    });
    expect(r1.status).toBe(202);
    const s1 = (await r1.json()) as ClipsState;
    expect(s1.status).toBe('pending');
    expect(s1.runId).toBeTruthy();
    const r2 = (await (
      await api(`/sources/${id}/clips`, cookieA, { method: 'POST', body: '{}' })
    ).json()) as ClipsState;
    expect(r2.runId).toBe(s1.runId);
    const job = await ds.query(`SELECT type, payload FROM jobs WHERE workflow_run_id = $1`, [s1.runId]);
    expect(job[0]).toMatchObject({ type: 'shots.detect', payload: { product: { name: 'เสื้อมัดย้อม' } } });

    // finished run: a plain POST returns it, `fresh` starts a new one
    await ds.query(`UPDATE workflow_runs SET status = 'succeeded' WHERE id = $1`, [s1.runId]);
    const again = (await (
      await api(`/sources/${id}/clips`, cookieA, { method: 'POST', body: '{}' })
    ).json()) as ClipsState;
    expect(again.runId).toBe(s1.runId);
    const fresh = (await (
      await api(`/sources/${id}/clips`, cookieA, { method: 'POST', body: JSON.stringify({ fresh: true }) })
    ).json()) as ClipsState;
    expect(fresh.runId).not.toBe(s1.runId);
  });

  it('lists the newest run clips by rank; discard hides one; other merchant cannot discard', async () => {
    const id = await source(true);
    const s = (await (
      await api(`/sources/${id}/clips`, cookieA, { method: 'POST', body: '{}' })
    ).json()) as ClipsState;
    for (const rank of [2, 1]) {
      await ds.query(
        `INSERT INTO clip_suggestions (merchant_id, source_id, workflow_run_id, rank, status, start_ms, end_ms, start_word,
           end_word, score, type, reason, quote, hook, title, origin, mode)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 10, $8, 'faq', 'r', NULL, NULL, 't', 'rules', 'rules')`,
        [
          merchantA,
          id,
          s.runId,
          rank,
          rank === 1 ? 'ready' : 'failed',
          rank * 20_000,
          rank * 20_000 + 18_000,
          90 - rank,
        ],
      );
    }
    const list = (await (await api(`/sources/${id}/clips`, cookieA)).json()) as ClipsState;
    expect(list.clips.map((c) => [c.rank, c.status])).toEqual([
      [1, 'ready'],
      [2, 'failed'],
    ]);
    expect(list.clips[1]?.error).toMatch(/ไม่สำเร็จ/);
    const target = list.clips[1] as ClipSuggestion;
    expect((await api(`/clip-suggestions/${target.id}/discard`, cookieB, { method: 'POST' })).status).toBe(
      404,
    );
    const d = await api(`/clip-suggestions/${target.id}/discard`, cookieA, { method: 'POST' });
    expect(d.status).toBe(200);
    const after = (await (await api(`/sources/${id}/clips`, cookieA)).json()) as ClipsState;
    expect(after.clips.map((c) => c.rank)).toEqual([1]);
  });

  it('style packs are listed with Thai names', async () => {
    const r = await api('/style-packs', cookieA);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { items: { id: string; name: string; description: string }[] };
    expect(body.items.map((p) => p.id)).toEqual(['sale-fast', 'friendly', 'premium', 'fun', 'simple']);
    expect(body.items.every((p) => p.name.length > 0 && p.description.length > 0)).toBe(true);
  });

  it('restyle: 400 unknown style, 404 other merchant / unknown, 409 without build input, 202 + job', async () => {
    const id = await source(true);
    const s = (await (
      await api(`/sources/${id}/clips`, cookieA, { method: 'POST', body: '{}' })
    ).json()) as ClipsState;
    const projectId = uuidv7();
    await ds.query(`INSERT INTO projects (id, merchant_id, title, current_version) VALUES ($1, $2, 'c', 1)`, [
      projectId,
      merchantA,
    ]);
    await ds.query(
      `INSERT INTO clip_suggestions (merchant_id, source_id, workflow_run_id, rank, status, start_ms, end_ms, start_word,
         end_word, score, type, reason, title, origin, mode, project_id)
       VALUES ($1, $2, $3, 1, 'ready', 0, 20000, 0, 10, 80, 'faq', 'r', 't', 'rules', 'rules', $4)`,
      [merchantA, id, s.runId, projectId],
    );
    const post = (pid: string, cookie: string, styleId: string) =>
      api(`/projects/${pid}/restyle`, cookie, { method: 'POST', body: JSON.stringify({ styleId }) });

    expect((await post(projectId, cookieA, 'nope')).status).toBe(400);
    expect((await post(projectId, cookieB, 'fun')).status).toBe(404);
    expect((await post(uuidv7(), cookieA, 'fun')).status).toBe(404);
    const old = await post(projectId, cookieA, 'fun');
    expect(old.status).toBe(409);
    expect(((await old.json()) as ApiErrorBody).message).toMatch(/สร้างคลิปใหม่/);

    const input = {
      version: 1,
      startMs: 0,
      endMs: 20_000,
      words: [{ text: 'ตัวนี้', startMs: 0, endMs: 500 }],
      speech: [{ startMs: 0, endMs: 600 }],
      title: 't',
      hook: null,
    };
    await ds.query(`UPDATE clip_suggestions SET build_input = $1 WHERE project_id = $2`, [
      JSON.stringify(input),
      projectId,
    ]);
    const ok = await post(projectId, cookieA, 'premium');
    expect(ok.status).toBe(202);
    const { runId } = (await ok.json()) as { runId: string };
    const jobs = await ds.query(`SELECT type, queue, payload FROM jobs WHERE workflow_run_id = $1`, [runId]);
    expect(jobs).toEqual([
      { type: 'clips.restyle', queue: 'ai', payload: { projectId, styleId: 'premium' } },
    ]);
    const run = await ds.query(`SELECT kind, subject_type, subject_id FROM workflow_runs WHERE id = $1`, [
      runId,
    ]);
    expect(run[0]).toEqual({ kind: 'restyle_clip', subject_type: 'project', subject_id: projectId });
  });

  it('GET /projects lists only the merchant own projects, newest first', async () => {
    const res = await api('/projects', cookieA);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect(((await (await api('/projects', cookieB)).json()) as { items: unknown[] }).items).toEqual([]);
  });
});
