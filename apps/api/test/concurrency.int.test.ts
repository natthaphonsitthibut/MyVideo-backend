import type { AddressInfo } from 'node:net';
import type { ProjectRecord } from '@myvideo/contracts';
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
const sourceId = Object.values(s01Clip.assets)[0]?.sourceId as string;

/** E11-F03: the same request arriving several times at once never makes duplicates or loses an edit. */
describe('concurrent requests (real Postgres)', () => {
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let cookie: string;
  let merchantId: string;
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const newProject = async () => {
    const { id: _i, merchantId: _m, ...doc } = structuredClone(s01Clip) as Record<string, unknown>;
    return (await (await call('POST', '/projects', { title: 'พร้อมกัน', doc })).json()) as ProjectRecord;
  };

  beforeAll(async () => {
    ds = await freshTestDb();
    merchantId = (await seedMerchant(ds, A)).merchant.id;
    await ds.query(
      `INSERT INTO video_sources (id, merchant_id, upload_id, title, original_filename, size_bytes, sha256, status)
       VALUES ($1, $2, 'up-s01', 'S01', 's01.mp4', 1, 'x', 'ready')`,
      [sourceId, merchantId],
    );
    app = await createApp(testEnv());
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    cookie = await loginCookie(app, A.email, A.password);
  });
  afterAll(async () => {
    await app.close();
    await ds.destroy();
  });

  it('5 export clicks at once on the same version → one render, one run', async () => {
    const p = await newProject();
    const res = await Promise.all(
      Array.from({ length: 5 }, () => call('POST', `/projects/${p.id}/renders`, { preset: 'standard' })),
    );
    expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const ids = new Set(await Promise.all(res.map(async (r) => ((await r.json()) as { id: string }).id)));
    expect(ids.size).toBe(1);
    const runs: { n: string }[] = await ds.query(
      `SELECT count(*) AS n FROM renders WHERE project_id = $1 AND merchant_id = $2`,
      [p.id, merchantId],
    );
    expect(Number(runs[0]?.n)).toBe(1);
  });

  it('two tabs save the same version at once → exactly one wins, the other gets 409 (no lost write)', async () => {
    const p = await newProject();
    const doc = (title: string) => {
      const { id: _i, merchantId: _m, ...rest } = structuredClone(p.doc) as Record<string, unknown>;
      return { ...rest, meta: { ...(rest.meta as object), title } };
    };
    const [a, b] = await Promise.all([
      call('PUT', `/projects/${p.id}`, { baseVersion: p.version, doc: doc('แท็บ 1') }),
      call('PUT', `/projects/${p.id}`, { baseVersion: p.version, doc: doc('แท็บ 2') }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const versions: { n: string }[] = await ds.query(
      `SELECT count(*) AS n FROM project_versions WHERE project_id = $1`,
      [p.id],
    );
    expect(Number(versions[0]?.n)).toBe(2); // create + the one winning save
  });

  it('3 review-video starts at once do not exceed the per-merchant run limit or fail with 500', async () => {
    const body = { sourceIds: [sourceId], templateId: 'showcase', product: { name: 'x', points: [] } };
    const res = await Promise.all(Array.from({ length: 3 }, () => call('POST', '/review-videos', body)));
    for (const r of res) expect([202, 429]).toContain(r.status);
  });
});
