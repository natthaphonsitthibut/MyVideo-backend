import type { AddressInfo } from 'node:net';
import type { ProjectRecord, RenderSummary } from '@myvideo/contracts';
import { createStorage, loadStageBundle, seedMerchant } from '@myvideo/infra';
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

function draft() {
  const { id: _id, merchantId: _m, ...rest } = structuredClone(s01Clip) as Record<string, unknown>;
  return rest;
}

describe('render API (real Postgres; the render itself is the worker’s, tested in infra)', () => {
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let cookieA: string;
  let cookieB: string;
  let project: ProjectRecord;
  const storage = createStorage(testEnv());

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
    const res = await call('POST', '/projects', cookieA, { title: 'คลิปส่งออก', doc: draft() });
    project = (await res.json()) as ProjectRecord;
  });
  afterAll(async () => {
    await app.close();
    await ds.destroy();
  });

  const call = (
    method: string,
    path: string,
    cookie: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${base}${path}`, {
      method,
      headers: { cookie, origin: base, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const requestRender = async (body: unknown = { preset: 'standard' }) => {
    const res = await call('POST', `/projects/${project.id}/renders`, cookieA, body);
    expect(res.status).toBe(200);
    return (await res.json()) as RenderSummary;
  };
  const count = async (sql: string, params: unknown[]) => Number((await ds.query(sql, params))[0].n);

  let first: RenderSummary;

  it('starts one render run per (version, preset, stage) and joins it while it runs', async () => {
    first = await requestRender();
    expect(first).toMatchObject({
      projectId: project.id,
      projectTitle: 'คลิปส่งออก',
      projectVersion: 1,
      preset: 'standard',
      status: 'queued',
      progress: 0,
      error: null,
      sizeBytes: null,
    });
    const [job] = await ds.query(`SELECT type, queue, payload FROM jobs WHERE workflow_run_id = $1`, [
      first.runId,
    ]);
    expect(job).toEqual({ type: 'render.video', queue: 'render', payload: { renderId: first.id } });
    const [row] = await ds.query(`SELECT stage_version FROM renders WHERE id = $1`, [first.id]);
    expect(row.stage_version).toBe((await loadStageBundle()).version);

    const again = await requestRender();
    expect(again.id).toBe(first.id);
    expect(again.runId).toBe(first.runId);
    expect(await count(`SELECT count(*) AS n FROM workflow_runs WHERE kind = 'render'`, [])).toBe(1);
    // another preset is another render
    const high = await requestRender({ preset: 'high' });
    expect(high.id).not.toBe(first.id);
  });

  it('lists renders per project and per merchant; other merchants see nothing', async () => {
    const perProject = (await (await call('GET', `/projects/${project.id}/renders`, cookieA)).json()) as {
      items: RenderSummary[];
    };
    expect(perProject.items.map((r) => r.preset).sort()).toEqual(['high', 'standard']);
    const all = (await (await call('GET', '/renders', cookieA)).json()) as { items: RenderSummary[] };
    expect(all.items).toHaveLength(2);
    expect(((await (await call('GET', '/renders', cookieB)).json()) as any).items).toEqual([]);
    expect((await call('GET', `/renders/${first.id}`, cookieB)).status).toBe(404);
    expect((await call('GET', `/renders/${first.id}/file`, cookieB)).status).toBe(404);
    expect(
      (await call('POST', `/projects/${project.id}/renders`, cookieB, { preset: 'standard' })).status,
    ).toBe(404);
    expect((await call('GET', `/projects/${project.id}/renders`, cookieB)).status).toBe(404);
  });

  it('shows progress while rendering and refuses the file until it is done', async () => {
    await ds.query(`UPDATE workflow_runs SET status = 'running' WHERE id = $1`, [first.runId]);
    await ds.query(`UPDATE jobs SET status = 'running', progress = 0.42 WHERE workflow_run_id = $1`, [
      first.runId,
    ]);
    const r = (await (await call('GET', `/renders/${first.id}`, cookieA)).json()) as RenderSummary;
    expect(r).toMatchObject({ status: 'rendering' });
    expect(r.progress).toBeCloseTo(0.42, 5);
    const file = await call('GET', `/renders/${first.id}/file`, cookieA);
    expect(file.status).toBe(409);
    expect(((await file.json()) as any).message).toBe('ไฟล์ยังเรนเดอร์ไม่เสร็จ');
  });

  it('a failed render shows a Thai reason and asking again starts a new run on the same render', async () => {
    await ds.query(`UPDATE workflow_runs SET status = 'failed' WHERE id = $1`, [first.runId]);
    await ds.query(`UPDATE jobs SET status = 'dead' WHERE workflow_run_id = $1`, [first.runId]);
    const failed = (await (await call('GET', `/renders/${first.id}`, cookieA)).json()) as RenderSummary;
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/ลองใหม่/);
    const retried = await requestRender();
    expect(retried.id).toBe(first.id);
    expect(retried.runId).not.toBe(first.runId);
    expect(retried.status).toBe('queued');
    first = retried;
  });

  it('a finished render is cached: same render returned, no new run; file streams with ranges', async () => {
    // plumbing bytes stand in for the MP4 here — the encode itself is tested on real footage in infra
    const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));
    const key = `m/${(await ds.query(`SELECT merchant_id FROM renders WHERE id = $1`, [first.id]))[0].merchant_id}/renders/${first.id}/output-test.mp4`;
    const stored = await storage.put(key, bytes);
    await ds.query(
      `UPDATE renders SET output_key = $2, size_bytes = $3, sha256 = $4, meta = '{"durationMs": 23666.7}', finished_at = now() WHERE id = $1`,
      [first.id, key, stored.size, stored.sha256],
    );
    await ds.query(`UPDATE workflow_runs SET status = 'succeeded' WHERE id = $1`, [first.runId]);
    const runsBefore = await count(`SELECT count(*) AS n FROM workflow_runs`, []);
    const t0 = performance.now();
    const cached = await requestRender();
    const ms = performance.now() - t0;
    console.log(`cached render request answered in ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(300); // instant: no render, no run
    expect(cached).toMatchObject({
      id: first.id,
      status: 'ready',
      progress: 1,
      sizeBytes: 4096,
      durationMs: 23667,
    });
    expect(await count(`SELECT count(*) AS n FROM workflow_runs`, [])).toBe(runsBefore);

    const whole = await call('GET', `/renders/${first.id}/file`, cookieA);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('video/mp4');
    expect(whole.headers.get('content-disposition')).toBeNull();
    expect(Buffer.from(await whole.arrayBuffer()).equals(bytes)).toBe(true);
    const part = await call('GET', `/renders/${first.id}/file`, cookieA, undefined, {
      range: 'bytes=100-199',
    });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 100-199/4096');
    expect(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(100, 200))).toBe(true);
    const dl = await call('GET', `/renders/${first.id}/file?download=1`, cookieA);
    expect(dl.headers.get('content-disposition')).toMatch(
      /^attachment; filename="myvideo-.*-v1-standard\.mp4"$/,
    );
    await dl.arrayBuffer();
  });

  it('a new version gets its own render; an unknown version is 404', async () => {
    const saved = await call('PUT', `/projects/${project.id}`, cookieA, { baseVersion: 1, doc: draft() });
    expect(saved.status).toBe(200);
    const v2 = await requestRender();
    expect(v2.projectVersion).toBe(2);
    expect(v2.id).not.toBe(first.id);
    const v1 = await requestRender({ preset: 'standard', version: 1 });
    expect(v1.id).toBe(first.id); // the old version's render is still the cached one
    expect((await call('POST', `/projects/${project.id}/renders`, cookieA, { version: 9 })).status).toBe(404);
    expect((await call('POST', `/projects/${project.id}/renders`, cookieA, { preset: 'ultra' })).status).toBe(
      400,
    );
  });
});
