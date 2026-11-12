import type { AddressInfo } from 'node:net';
import { seedMerchant } from '@myvideo/infra';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import clip from '../../../libs/contracts/src/project/fixtures/s01-clip.project.json' with { type: 'json' };
import { freshTestDb } from '../../../test/test-db.js';
import { testEnv } from '../../../test/test-env.js';
import { createApp } from '../src/app.js';
import { loginCookie } from './helpers.js';

let ds: DataSource;
let app: INestApplication;
let base: string;
let a: string;
let b: string;
let merchant: string;
const source = '00000000-0000-7000-8000-000000000123';
beforeAll(async () => {
  ds = await freshTestDb();
  for (const name of ['a', 'b']) {
    const seeded = await seedMerchant(ds, {
      merchantName: name,
      merchantSlug: `folder-${name}`,
      email: `${name}@folder.local`,
      password: 'password-folder',
      displayName: name,
    });
    if (name === 'a') merchant = seeded.merchant.id;
  }
  await ds.query(
    `INSERT INTO video_sources (id,merchant_id,upload_id,title,original_filename,size_bytes,sha256,status) VALUES ($1,$2,'folder-upload','S01','s01.mp4',1,'x','ready')`,
    [source, merchant],
  );
  app = await createApp(testEnv());
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  a = await loginCookie(app, 'a@folder.local', 'password-folder');
  b = await loginCookie(app, 'b@folder.local', 'password-folder');
});
afterAll(async () => {
  await app?.close();
  await ds?.destroy();
});
const call = (method: string, path: string, cookie: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { cookie, origin: base, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

it('creates a folder, adds an existing library video idempotently, separates clips, and survives reload', async () => {
  const made = await call('POST', '/folders', a, { title: 'เสื้อใหม่' });
  expect(made.status).toBe(201);
  const folder = (await made.json()) as { id: string };
  for (let i = 0; i < 2; i++)
    expect((await call('POST', `/folders/${folder.id}/sources`, a, { sourceIds: [source] })).status).toBe(
      200,
    );
  const detail = await (await call('GET', `/folders/${folder.id}`, a)).json();
  expect(detail).toMatchObject({ title: 'เสื้อใหม่', sourceIds: [source], clipIds: [] });
  const { id: _id, merchantId: _merchant, ...doc } = structuredClone(clip);
  for (const asset of Object.values(doc.assets)) asset.sourceId = source;
  const built = await call('POST', '/projects', a, { title: 'คลิปจากฟุตเทจ', doc });
  expect(built.status).toBe(201);
  const edited = (await built.json()) as { id: string };
  expect(await (await call('GET', `/folders/${folder.id}`, a)).json()).toMatchObject({
    sourceIds: [source],
    clipIds: [edited.id],
  });
  expect((await call('GET', `/sources/${source}`, a)).status).toBe(200);
  expect((await call('GET', `/projects/${edited.id}`, a)).status).toBe(200);
  expect(((await (await call('GET', '/folders', a)).json()) as { items: unknown[] }).items).toHaveLength(1);
  expect((await call('DELETE', `/folders/${folder.id}`, a)).status).toBe(204);
  expect((await call('GET', `/folders/${folder.id}`, a)).status).toBe(404);
  expect((await call('GET', `/sources/${source}`, a)).status).toBe(200);
});

it('never exposes another merchant folder or attaches a foreign source; rejects the entire batch', async () => {
  const folder = (await (await call('POST', '/folders', a, { title: 'ส่วนตัว' })).json()) as { id: string };
  expect((await call('GET', `/folders/${folder.id}`, b)).status).toBe(404);
  expect((await call('POST', `/folders/${folder.id}/sources`, b, { sourceIds: [source] })).status).toBe(404);
  const other = (await (await call('POST', '/folders', b, { title: 'ร้านบี' })).json()) as { id: string };
  expect((await call('POST', `/folders/${other.id}/sources`, b, { sourceIds: [source] })).status).toBe(404);
  expect(
    (
      await call('POST', `/folders/${folder.id}/sources`, a, {
        sourceIds: [source, '00000000-0000-7000-8000-000000000999'],
      })
    ).status,
  ).toBe(404);
  expect(await (await call('GET', `/folders/${folder.id}`, a)).json()).toMatchObject({ sourceIds: [] });
});
