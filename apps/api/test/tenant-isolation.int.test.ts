import type { AddressInfo } from 'node:net';
import { type ProjectRecord, routes } from '@myvideo/contracts';
import { seedMerchant } from '@myvideo/infra';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import s01Clip from '../../../libs/contracts/src/project/fixtures/s01-clip.project.json' with {
  type: 'json',
};
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
const sourceId = Object.values(s01Clip.assets)[0]?.sourceId as string;

/** Routes that are not merchant data at all (same for everyone) or need no id. */
const SHARED = new Set([
  'get /library/sounds/{id}',
  'get /templates',
  'get /style-packs',
  'get /health',
  'post /auth/login',
]);

/**
 * Tenant isolation (E11-F01), generated from the route contracts: for EVERY authenticated route that takes an id,
 * merchant B calls it with merchant A's real ids and must get no 2xx and none of A's data; list routes never show
 * A's rows to B. A route with a path parameter this suite cannot fill fails the suite, so a new endpoint is covered
 * (or consciously listed) the day it is added.
 */
describe('tenant isolation over every route (real Postgres)', () => {
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let cookieA: string;
  let cookieB: string;
  const ids: Record<string, string> = {};

  const call = (method: string, path: string, cookie: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: method.toUpperCase(),
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeAll(async () => {
    ds = await freshTestDb();
    const a = (await seedMerchant(ds, A)).merchant.id;
    await seedMerchant(ds, B);
    await ds.query(
      `INSERT INTO video_sources (id, merchant_id, upload_id, title, original_filename, size_bytes, sha256, status)
       VALUES ($1, $2, 'up-s01', 'S01', 's01.mp4', 1, 'x', 'ready')`,
      [sourceId, a],
    );
    app = await createApp(testEnv());
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    cookieA = await loginCookie(app, A.email, A.password);
    cookieB = await loginCookie(app, B.email, B.password);
    const { id: _i, merchantId: _m, ...doc } = structuredClone(s01Clip) as Record<string, unknown>;
    const project = (await (
      await call('post', '/projects', cookieA, { title: 'ของร้าน A', doc })
    ).json()) as ProjectRecord;
    ids.project = project.id;
    const render = (await (
      await call('post', `/projects/${project.id}/renders`, cookieA, { preset: 'standard' })
    ).json()) as { id: string };
    ids.render = render.id;
    const job: { id: string; workflow_run_id: string }[] = await ds.query(
      `SELECT id, workflow_run_id FROM jobs WHERE merchant_id = $1 LIMIT 1`,
      [a],
    );
    ids.job = job[0]?.id as string;
    ids.run = job[0]?.workflow_run_id as string;
    const review = (await (
      await call('post', '/review-videos', cookieA, {
        sourceIds: [sourceId],
        templateId: 'showcase',
        product: { name: 'ของ A', points: [] },
      })
    ).json()) as { runId: string };
    ids.review = review.runId;
    const sug: { id: string }[] = await ds.query(
      `INSERT INTO clip_suggestions (merchant_id, source_id, workflow_run_id, rank, start_ms, end_ms, start_word, end_word,
         score, type, reason, title, origin, mode)
       VALUES ($1, $2, $3, 1, 0, 1000, 0, 1, 50, 'other', 'r', 't', 'rules', 'rules') RETURNING id`,
      [a, sourceId, ids.run],
    );
    ids.suggestion = sug[0]?.id as string;
    await call('put', '/brand-kit', cookieA, {
      primaryColor: '#123456',
      accentColor: '#abcdef',
      textColor: '#ffffff',
      font: 'noto-sans-thai',
      defaultCta: 'ร้านเอเท่านั้น',
    });
    for (const [k, v] of Object.entries(ids)) expect(v, `fixture ${k}`).toMatch(/^[0-9a-f-]{36}$/);
  }, 60_000);
  afterAll(async () => {
    await app.close();
    await ds.destroy();
  });

  /** A's real resource for a path, or null when the route has no merchant resource in its path. */
  function fill(path: string): string | null {
    const id = path.startsWith('/sources/by-upload/')
      ? null
      : path.startsWith('/sources/')
        ? sourceId
        : path.startsWith('/projects/')
          ? ids.project
          : path.startsWith('/renders/')
            ? ids.render
            : path.startsWith('/jobs/')
              ? ids.job
              : path.startsWith('/workflow-runs/')
                ? ids.run
                : path.startsWith('/clip-suggestions/')
                  ? ids.suggestion
                  : path.startsWith('/review-videos/')
                    ? ids.review
                    : undefined;
    if (id === undefined) throw new Error(`tenant suite has no fixture for ${path} — add one`);
    return path
      .replace('{uploadId}', 'up-s01')
      .replace('{id}', id ?? '')
      .replace('{kind}', 'proxy')
      .replace('{sheet}', '0')
      .replace('{seq}', '0')
      .replace('{index}', '0')
      .replace('{version}', '1');
  }

  /** Bodies that pass validation, so a refusal is about ownership, not the payload. */
  const BODY: Record<string, unknown> = {
    'put /projects/{id}': { baseVersion: 1, doc: {} },
    'post /projects/{id}/renders': { preset: 'standard' },
    'post /projects/{id}/restyle': { styleId: 'sale-fast' },
    'post /projects/{id}/template': { templateId: 'review' },
    'post /sources/{id}/clips': {},
    'post /sources/{id}/clips/build': { styleId: 'sale-fast' },
    'post /sources/{id}/transcript': {},
    'put /sources/{id}/transcript/words/{seq}/{index}': { text: 'ก' },
  };

  it('B gets no 2xx and none of A’s data on every route that takes A’s id', async () => {
    const checked: string[] = [];
    for (const r of routes) {
      const key = `${r.method} ${r.path}`;
      if (!r.auth || SHARED.has(key) || !r.path.includes('{')) continue;
      const path = fill(r.path);
      if (path === null) continue;
      const res = await call(
        r.method,
        path,
        cookieB,
        r.method === 'get' || r.method === 'delete' ? undefined : (BODY[key] ?? {}),
      );
      const text = await res.text();
      expect(res.status, `${key} as B → ${res.status} ${text.slice(0, 200)}`).toBeGreaterThanOrEqual(400);
      expect(res.status, key).not.toBe(500);
      for (const v of [...Object.values(ids), sourceId, 'ของร้าน A']) expect(text, key).not.toContain(v);
      checked.push(key);
    }
    // every id-taking authenticated route was exercised
    expect(checked.length).toBeGreaterThanOrEqual(25);
  });

  it('list routes never show A’s rows to B; B’s brand kit is B’s own', async () => {
    for (const path of ['/sources', '/projects', '/renders', '/workflow-runs']) {
      const res = await call('get', path, cookieB);
      expect(res.status, path).toBe(200);
      const text = await res.text();
      for (const v of [...Object.values(ids), sourceId]) expect(text, path).not.toContain(v);
    }
    const kit = await (await call('get', '/brand-kit', cookieB)).json();
    expect(kit).toMatchObject({ primaryColor: '#111111', defaultCta: 'กดตะกร้า สั่งได้เลย' });
    expect((await call('get', '/brand-kit/logo', cookieB)).status).toBe(404);
    // B cannot start work on A's video
    const res = await call('post', '/review-videos', cookieB, {
      sourceIds: [sourceId],
      templateId: 'review',
      product: { name: 'x', points: [] },
    });
    expect(res.status).toBe(404);
  });

  it('the same calls work for A (the fixtures are real, not just missing)', async () => {
    for (const path of [
      `/projects/${ids.project}`,
      `/renders/${ids.render}`,
      `/workflow-runs/${ids.run}`,
      `/review-videos/${ids.review}`,
      `/sources/${sourceId}`,
    ]) {
      expect((await call('get', path, cookieA)).status, path).toBe(200);
    }
  });
});
