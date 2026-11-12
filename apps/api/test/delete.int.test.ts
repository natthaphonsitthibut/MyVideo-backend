import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectRecord, SourceDependents } from '@myvideo/contracts';
import { storageKeys } from '@myvideo/domain';
import { createStorage, seedMerchant } from '@myvideo/infra';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import s01Clip from '../../../libs/contracts/src/project/fixtures/s01-clip.project.json' with {
  type: 'json',
};
import { footageClip } from '../../../test/footage.js';
import { freshTestDb } from '../../../test/test-db.js';
import { testEnv } from '../../../test/test-env.js';
import { createApp } from '../src/app.js';
import { loginCookie } from './helpers.js';

// Real footage bytes locally; CI without footage stores plumbing bytes (only storage/DB behaviour is under test).
const CLIP = footageClip('talkinghead-th-portrait.mp4');
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
const FIXTURE_SOURCE = Object.values(s01Clip.assets)[0]?.sourceId as string;

/** A project document that uses `sourceId` (the S01 clip fixture, re-pointed). */
function docFor(sourceId: string) {
  const { id: _id, merchantId: _m, ...rest } = structuredClone(s01Clip) as Record<string, unknown>;
  const json = JSON.stringify(rest).replaceAll(FIXTURE_SOURCE, sourceId);
  return JSON.parse(json) as Record<string, unknown>;
}

describe(`delete sources and projects (${CLIP ? 'real footage bytes' : 'plumbing bytes'})`, () => {
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let cookieA: string;
  let cookieB: string;
  let merchantA: string;
  let merchantB: string;
  let bytes: Buffer;
  const scratch = mkdtempSync(join(tmpdir(), 'myvideo-delete-test-'));
  const env = testEnv({
    STORAGE_LOCAL_DIR: join(scratch, 'storage'),
    UPLOAD_TMP_DIR: join(scratch, 'uploads'),
  });
  const storage = createStorage(env);

  const call = (method: string, path: string, cookie: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const count = async (sql: string, params: unknown[]) => Number((await ds.query(sql, params))[0].n);

  /** A ready source with an original + a derived file in storage, analyses rows and a still-running ingest job. */
  async function makeSource(merchantId: string, title: string) {
    const [row] = (await ds.query('SELECT uuidv7() AS id')) as { id: string }[];
    const id = row?.id ?? '';
    const original = storageKeys.original(merchantId, id, 'mp4');
    const stored = await storage.put(original, bytes);
    const proxyKey = storageKeys.derived(merchantId, id, id, 'proxy', 1, 'mp4');
    await storage.put(proxyKey, bytes.subarray(0, 1024));
    await ds.query(
      `INSERT INTO video_sources (id, merchant_id, upload_id, title, original_filename, size_bytes, sha256, status)
       VALUES ($1, $2, $3, $4, 'x.mp4', $5, $6, 'ready')`,
      [id, merchantId, `up-${id}`, title, stored.size, stored.sha256],
    );
    await ds.query(
      `INSERT INTO media_assets (merchant_id, source_id, kind, storage_key, size_bytes, sha256, content_type)
       VALUES ($1, $2, 'original', $3, $4, $5, 'video/mp4'), ($1, $2, 'proxy', $6, 1024, 'p', 'video/mp4')`,
      [merchantId, id, original, stored.size, stored.sha256, proxyKey],
    );
    const [run] = (await ds.query(
      `INSERT INTO workflow_runs (merchant_id, kind, status, subject_type, subject_id)
       VALUES ($1, 'ingest', 'running', 'source', $2) RETURNING id`,
      [merchantId, id],
    )) as { id: string }[];
    await ds.query(
      `INSERT INTO jobs (merchant_id, workflow_run_id, type, queue, idempotency_key, payload, status)
       VALUES ($1, $2, 'media.sprites', 'media', $3, $4, 'pending'),
              ($1, $2, 'media.proxy', 'media', $5, $4, 'running')`,
      [merchantId, run?.id, `t:${id}:sprites`, JSON.stringify({ sourceId: id }), `t:${id}:proxy`],
    );
    return { id, original, proxyKey, runId: run?.id as string };
  }

  beforeAll(async () => {
    bytes = CLIP ? await readFile(CLIP) : Buffer.alloc(64 * 1024, 7);
    ds = await freshTestDb();
    merchantA = (await seedMerchant(ds, A)).merchant.id;
    merchantB = (await seedMerchant(ds, B)).merchant.id;
    app = await createApp(env);
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    cookieA = await loginCookie(app, A.email, A.password);
    cookieB = await loginCookie(app, B.email, B.password);
  });
  afterAll(async () => {
    await app.close();
    await ds.destroy();
    rmSync(scratch, { recursive: true, force: true });
  });

  it('deletes an unused source at once: rows gone, its work cancelled, a purge run queued for its files', async () => {
    const s = await makeSource(merchantA, 'ไม่มีโปรเจกต์');
    const deps = (await (
      await call('GET', `/sources/${s.id}/dependents`, cookieA)
    ).json()) as SourceDependents;
    expect(deps.projects).toEqual([]);

    expect((await call('DELETE', `/sources/${s.id}`, cookieA)).status).toBe(204);
    expect((await call('GET', `/sources/${s.id}`, cookieA)).status).toBe(404);
    expect(await count('SELECT count(*) AS n FROM media_assets WHERE source_id = $1', [s.id])).toBe(0);
    const jobs = (await ds.query(
      'SELECT type, status, cancel_requested FROM jobs WHERE workflow_run_id = $1 ORDER BY type',
      [s.runId],
    )) as { type: string; status: string; cancel_requested: boolean }[];
    expect(jobs).toEqual([
      { type: 'media.proxy', status: 'running', cancel_requested: true }, // the worker aborts it
      { type: 'media.sprites', status: 'cancelled', cancel_requested: true },
    ]);
    const purge = (await ds.query(
      `SELECT j.type, j.payload FROM jobs j JOIN workflow_runs r ON r.id = j.workflow_run_id
        WHERE r.kind = 'purge' AND r.subject_id = $1`,
      [s.id],
    )) as { type: string; payload: { prefixes: string[] } }[];
    expect(purge).toHaveLength(1);
    expect(purge[0]?.type).toBe('storage.purge');
    expect(purge[0]?.payload.prefixes).toEqual([`m/${merchantA}/sources/${s.id}/`]);
    // idempotent: deleting again (or an id that never existed) is still 204
    expect((await call('DELETE', `/sources/${s.id}`, cookieA)).status).toBe(204);
  });

  it('refuses while projects use the source, lists them, and deletes them only when confirmed', async () => {
    const s = await makeSource(merchantA, 'มีโปรเจกต์');
    const created = await call('POST', '/projects', cookieA, { title: 'คลิปจากวิดีโอนี้', doc: docFor(s.id) });
    expect(created.status).toBe(201);
    const project = (await created.json()) as ProjectRecord;
    const other = await makeSource(merchantA, 'อีกวิดีโอ');
    const keep = (await (
      await call('POST', '/projects', cookieA, { title: 'คลิปอื่น', doc: docFor(other.id) })
    ).json()) as ProjectRecord;

    const deps = (await (
      await call('GET', `/sources/${s.id}/dependents`, cookieA)
    ).json()) as SourceDependents;
    expect(deps.projects).toEqual([{ id: project.id, title: 'คลิปจากวิดีโอนี้' }]);

    const refused = await call('DELETE', `/sources/${s.id}`, cookieA);
    expect(refused.status).toBe(409);
    expect((await call('GET', `/sources/${s.id}`, cookieA)).status).toBe(200); // nothing changed

    expect((await call('DELETE', `/sources/${s.id}?withProjects=true`, cookieA)).status).toBe(204);
    expect((await call('GET', `/projects/${project.id}`, cookieA)).status).toBe(404);
    expect((await call('GET', `/projects/${keep.id}`, cookieA)).status).toBe(200);
    expect((await call('GET', `/sources/${other.id}`, cookieA)).status).toBe(200);
  });

  it("never touches another merchant's source (same 204, nothing deleted)", async () => {
    const theirs = await makeSource(merchantB, 'ของร้าน B');
    expect((await call('GET', `/sources/${theirs.id}/dependents`, cookieA)).status).toBe(404);
    expect((await call('DELETE', `/sources/${theirs.id}?withProjects=true`, cookieA)).status).toBe(204);
    expect((await call('GET', `/sources/${theirs.id}`, cookieB)).status).toBe(200);
    expect(await count('SELECT count(*) AS n FROM media_assets WHERE source_id = $1', [theirs.id])).toBe(2);
    expect(await storage.stat(theirs.original)).not.toBeNull();
  });

  it('deletes a project with its versions and renders; the source stays', async () => {
    const s = await makeSource(merchantA, 'วิดีโอคงอยู่');
    const project = (await (
      await call('POST', '/projects', cookieA, { title: 'ลบโปรเจกต์', doc: docFor(s.id) })
    ).json()) as ProjectRecord;
    expect((await call('DELETE', `/projects/${project.id}`, cookieB)).status).toBe(204); // B: no effect
    expect((await call('GET', `/projects/${project.id}`, cookieA)).status).toBe(200);

    expect((await call('DELETE', `/projects/${project.id}`, cookieA)).status).toBe(204);
    expect((await call('GET', `/projects/${project.id}`, cookieA)).status).toBe(404);
    expect(
      await count('SELECT count(*) AS n FROM project_versions WHERE project_id = $1', [project.id]),
    ).toBe(0);
    expect((await call('GET', `/sources/${s.id}`, cookieA)).status).toBe(200);
  });
});
