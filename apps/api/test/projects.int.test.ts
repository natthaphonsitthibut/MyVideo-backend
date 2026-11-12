import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiErrorBody, ProjectRecord } from '@myvideo/contracts';
import { SOUND_LIBRARY } from '@myvideo/contracts';
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

/** The real-data fixture (S01 clip) as a client draft: server owns id + merchantId. */
function draft() {
  const { id: _id, merchantId: _m, ...rest } = structuredClone(s01Clip) as Record<string, unknown>;
  return rest as Record<string, unknown> & {
    elements: Record<string, Record<string, unknown>>;
    meta: Record<string, unknown>;
  };
}
const sourceId = Object.values(s01Clip.assets)[0]?.sourceId as string;

describe('project API with optimistic locking (real Postgres)', () => {
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let cookieA: string;
  let cookieB: string;
  let soundsDir: string;

  beforeAll(async () => {
    ds = await freshTestDb();
    const a = (await seedMerchant(ds, A)).merchant.id;
    await seedMerchant(ds, B);
    // the fixture's asset points at this source: it must exist and belong to merchant A
    await ds.query(
      `INSERT INTO video_sources (id, merchant_id, upload_id, title, original_filename, size_bytes, sha256, status)
       VALUES ($1, $2, 'up-s01', 'S01', 's01.mp4', 1, 'x', 'ready')`,
      [sourceId, a],
    );
    soundsDir = await mkdtemp(join(tmpdir(), 'library-api-'));
    app = await createApp(testEnv({ SOUND_LIBRARY_DIR: soundsDir }));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    cookieA = await loginCookie(app, A.email, A.password);
    cookieB = await loginCookie(app, B.email, B.password);
  });
  afterAll(async () => {
    await app.close();
    await ds.destroy();
    await rm(soundsDir, { recursive: true, force: true });
  });

  const call = (method: string, path: string, cookie: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function create(): Promise<ProjectRecord> {
    const res = await call('POST', '/projects', cookieA, { title: 'คลิปเสื้อแบดบอย', doc: draft() });
    expect(res.status).toBe(201);
    return (await res.json()) as ProjectRecord;
  }

  it('streams authenticated library bytes and byte ranges, with normal missing-file errors', async () => {
    const path = `/library/sounds/${SOUND_LIBRARY[0]!.id}`;
    expect((await call('GET', path, '')).status).toBe(401);
    const unknown = await call('GET', '/library/sounds/unknown', cookieA);
    expect(unknown.status).toBe(404);
    expect((await unknown.json()) as ApiErrorBody).toHaveProperty('error');
    expect((await call('GET', path, cookieA)).status).toBe(404);
    const bytes = Buffer.from([0, 1, 2, 3, 4, 5]); // Streaming plumbing only.
    await writeFile(join(soundsDir, `${SOUND_LIBRARY[0]!.id}.wav`), bytes);
    const full = await call('GET', path, cookieA);
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toBe('audio/wav');
    expect(full.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await full.arrayBuffer())).toEqual(bytes);
    const part = await fetch(`${base}${path}`, { headers: { cookie: cookieA, range: 'bytes=1-3' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 1-3/6');
    expect(part.headers.get('content-length')).toBe('3');
    expect(Buffer.from(await part.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));
    const outside = await fetch(`${base}${path}`, { headers: { cookie: cookieA, range: 'bytes=10-' } });
    expect(outside.status).toBe(416);
  });

  it('saves library audio alongside owned sources and rejects an unknown library id', async () => {
    const p = await create();
    const d = draft();
    const assetId = '01a1cd80-0000-7000-8000-000000000011';
    const trackId = '01a1cd80-0000-7000-8000-000000000012';
    const elementId = '01a1cd80-0000-7000-8000-000000000013';
    const asset = { libraryId: SOUND_LIBRARY[0]!.id, kind: 'audio', durationFrames: 8, hasAudio: true };
    (d.assets as Record<string, unknown>)[assetId] = asset;
    (d.tracks as unknown[]).push({ id: trackId, kind: 'audio', elementIds: [elementId] });
    d.elements[elementId] = {
      id: elementId,
      trackId,
      type: 'audio',
      assetId,
      startFrame: 0,
      durationFrames: 6,
      sourceInFrame: 0,
      playbackRate: 1,
      volume: 0.5,
      origin: 'user',
    };
    const saved = await call('PUT', `/projects/${p.id}`, cookieA, { baseVersion: 1, doc: d });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as ProjectRecord).doc.assets[assetId]).toEqual(asset);
    asset.libraryId = 'unknown';
    const rejected = await call('PUT', `/projects/${p.id}`, cookieA, { baseVersion: 2, doc: d });
    expect(rejected.status).toBe(400);
    expect(((await rejected.json()) as ApiErrorBody).error).toBe('invalid_project');
  });

  it('create → get: version 1, server-owned id/merchantId, doc round-trips', async () => {
    const p = await create();
    expect(p.version).toBe(1);
    expect(p.doc.id).toBe(p.id);
    expect(p.doc.elements).toEqual(s01Clip.elements);
    const got = (await (await call('GET', `/projects/${p.id}`, cookieA)).json()) as ProjectRecord;
    expect(got).toEqual(p);
    expect((await call('GET', `/projects/${p.id}`, cookieB)).status).toBe(404);
  });

  it('save on the current version → new version; save on a stale base → 409', async () => {
    const p = await create();
    const d = draft();
    d.meta.title = 'แก้ชื่อแล้ว';
    const ok = await call('PUT', `/projects/${p.id}`, cookieA, { baseVersion: 1, doc: d });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as ProjectRecord).version).toBe(2);
    const stale = await call('PUT', `/projects/${p.id}`, cookieA, { baseVersion: 1, doc: draft() });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as ApiErrorBody).error).toBe('version_conflict');
    expect((await call('PUT', `/projects/${p.id}`, cookieB, { baseVersion: 2, doc: draft() })).status).toBe(
      404,
    );
  });

  it('two concurrent saves on the same base: exactly one wins', async () => {
    const p = await create();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => {
        const d = draft();
        d.meta.title = `writer ${i}`;
        return call('PUT', `/projects/${p.id}`, cookieA, { baseVersion: 1, doc: d });
      }),
    );
    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([200, 409, 409, 409, 409, 409]);
    const rows: { n: string }[] = await ds.query(
      `SELECT count(*) AS n FROM project_versions WHERE project_id = $1`,
      [p.id],
    );
    expect(Number(rows[0]?.n)).toBe(2);
  });

  it('every save is validated: overlap / missing source → 400 with issues, nothing stored', async () => {
    const p = await create();
    const d = draft();
    const caps = Object.values(d.elements).filter((e) => e.type === 'caption');
    (caps[1] as Record<string, unknown>).startFrame = caps[0]?.startFrame; // two captions at the same time
    const bad = await call('PUT', `/projects/${p.id}`, cookieA, { baseVersion: 1, doc: d });
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as ApiErrorBody;
    expect(body.error).toBe('invalid_project');
    expect(body.issues?.some((i) => i.message.startsWith('overlap:'))).toBe(true);

    const foreign = draft();
    for (const a of Object.values(foreign.assets as Record<string, { sourceId: string }>))
      a.sourceId = '01a1cd80-0000-7000-8000-000000000000';
    const res = await call('POST', '/projects', cookieA, { title: 'x', doc: foreign });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ApiErrorBody).issues?.[0]?.message).toMatch(/^missing_asset:/);
    // merchant B cannot use A's source either
    expect((await call('POST', '/projects', cookieB, { title: 'x', doc: draft() })).status).toBe(400);

    const rows: { n: string }[] = await ds.query(
      `SELECT count(*) AS n FROM project_versions WHERE project_id = $1`,
      [p.id],
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('versions list + restore creates a new version with the old doc', async () => {
    const p = await create();
    const d = draft();
    d.meta.title = 'v2';
    await call('PUT', `/projects/${p.id}`, cookieA, { baseVersion: 1, doc: d });
    const restored = await call('POST', `/projects/${p.id}/versions/1/restore`, cookieA, { baseVersion: 2 });
    expect(restored.status).toBe(200);
    const r = (await restored.json()) as ProjectRecord;
    expect(r.version).toBe(3);
    expect(r.doc.meta).toEqual(p.doc.meta);
    const list = (await (await call('GET', `/projects/${p.id}/versions`, cookieA)).json()) as {
      items: { version: number; reason: string; restoredFrom: number | null }[];
    };
    expect(list.items.map((v) => [v.version, v.reason, v.restoredFrom])).toEqual([
      [3, 'restore', 1],
      [2, 'save', null],
      [1, 'create', null],
    ]);
    expect(
      (await call('POST', `/projects/${p.id}/versions/1/restore`, cookieA, { baseVersion: 2 })).status,
    ).toBe(409);
    expect(
      (await call('POST', `/projects/${p.id}/versions/9/restore`, cookieA, { baseVersion: 3 })).status,
    ).toBe(404);
  });
});
