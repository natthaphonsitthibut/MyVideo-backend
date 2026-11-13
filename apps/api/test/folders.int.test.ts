import type { AddressInfo } from 'node:net';
import { seedMerchant } from '@myvideo/infra';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import clip from '../../../libs/contracts/src/project/fixtures/s01-clip.project.json' with { type: 'json' };
import { grammarPack, measureGrammar } from '../../../libs/infra/src/reference/reference-grammar.js';
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

it('separates reference uploads from footage, exposes only the owning merchant recipe, and locks it through the API', async () => {
  const refSource = '00000000-0000-7000-8000-000000000887';
  await ds.query(
    `INSERT INTO video_sources(id,merchant_id,upload_id,title,original_filename,status,size_bytes,sha256)VALUES($1,$2,'ref-api-plumbing','reference','reference.mp4','ready',1,'plumbing')`,
    [refSource, merchant],
  );
  const created = await call('POST', '/reference-styles', a, {
    sourceId: refSource,
    title: 'Reference style',
  });
  expect(created.status).toBe(202);
  const r = (await created.json()) as { id: string; status: string };
  expect(r.status).toBe('processing');
  expect((await call('POST', '/reference-styles', b, { sourceId: refSource, title: 'Foreign' })).status).toBe(
    404,
  );
  const library = (await (await call('GET', '/sources', a)).json()) as { items: { id: string }[] };
  expect(library.items.some((s) => s.id === refSource)).toBe(false);
  const grammar = measureGrammar(10000, [0, 2000, 4000, 10000], ['#123456'], [], null),
    snapshot = grammarPack(r.id, 'Reference style', grammar);
  await ds.query("UPDATE reference_styles SET status='ready',grammar=$2,snapshot=$3 WHERE id=$1", [
    r.id,
    JSON.stringify(grammar),
    JSON.stringify(snapshot),
  ]);
  const own = (await (await call('GET', '/style-packs', a)).json()) as { items: { id: string }[] };
  const other = (await (await call('GET', '/style-packs', b)).json()) as { items: { id: string }[] };
  expect(own.items.some((s) => s.id === snapshot.pack.id)).toBe(true);
  expect(other.items.some((s) => s.id === snapshot.pack.id)).toBe(false);
  expect((await call('POST', `/reference-styles/${r.id}/lock`, b)).status).toBe(404);
  expect((await call('POST', `/reference-styles/${r.id}/lock`, a)).status).toBe(204);
  const folder = (await (await call('POST', '/folders', a, { title: 'Reference copy guard' })).json()) as {
    id: string;
  };
  expect((await call('POST', `/folders/${folder.id}/sources`, a, { sourceIds: [refSource] })).status).toBe(
    404,
  );
  const { id: _id, merchantId: _m, ...doc } = structuredClone(clip);
  for (const asset of Object.values(doc.assets)) asset.sourceId = refSource;
  expect((await call('POST', '/projects', a, { title: 'Forbidden reference footage', doc })).status).toBe(
    400,
  );
  expect((await call('DELETE', `/folders/${folder.id}`, a)).status).toBe(204);
  expect((await call('DELETE', '/folders/style-lock', a)).status).toBe(204);
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

it('stores edit settings: defaults on create, typed product text kept as typed, partial update, tenant-scoped', async () => {
  const made = await call('POST', '/folders', a, { title: 'ตั้งค่า' });
  const folder = (await made.json()) as { id: string; settings: unknown };
  expect(folder.settings).toEqual({
    musicId: null,
    ratio: 'auto',
    goal: 'sell',
    length: 'auto',
    productName: null,
    productPrice: null,
  });
  const settings = {
    ratio: '16:9',
    goal: 'review',
    length: '30',
    productName: 'เสื้อมัดย้อม ลายหมาป่า',
    productPrice: '80 บาท',
  };
  const updated = await call('PATCH', `/folders/${folder.id}`, a, { settings });
  expect(updated.status).toBe(200);
  expect(await updated.json()).toMatchObject({ title: 'ตั้งค่า', settings });
  // rename keeps the settings
  await call('PATCH', `/folders/${folder.id}`, a, { title: 'ตั้งค่าใหม่' });
  expect(await (await call('GET', `/folders/${folder.id}`, a)).json()).toMatchObject({
    title: 'ตั้งค่าใหม่',
    settings,
  });
  const created = await call('POST', '/folders', a, { title: 'สร้างพร้อมค่า', settings: { ratio: '1:1' } });
  expect(((await created.json()) as { settings: { ratio: string; goal: string } }).settings).toMatchObject({
    ratio: '1:1',
    goal: 'sell',
  });
  expect((await call('PATCH', `/folders/${folder.id}`, a, { settings: { ratio: '21:9' } })).status).toBe(400);
  expect((await call('PATCH', `/folders/${folder.id}`, a, {})).status).toBe(400);
  expect((await call('PATCH', `/folders/${folder.id}`, b, { title: 'ขโมย' })).status).toBe(404);
});

it('plan panel: steps before start, 409 on an empty folder, start joins, style rules, tenant-scoped', async () => {
  const folder = (await (await call('POST', '/folders', a, { title: 'แผนงาน' })).json()) as { id: string };
  const before = (await (await call('GET', `/folders/${folder.id}/plan`, a)).json()) as {
    steps: { id: string }[];
  };
  expect(before).toMatchObject({ runId: null, done: 0, total: 5, needs: null, proposals: [] });
  expect(before.steps.map((s: { id: string }) => s.id)).toEqual([
    'prepare',
    'transcribe',
    'analyse',
    'style',
    'edit',
  ]);
  expect((await call('POST', `/folders/${folder.id}/edit`, a, {})).status).toBe(409);
  expect((await call('POST', `/folders/${folder.id}/style`, a, { styleId: 'sale-fast' })).status).toBe(409);
  await call('POST', `/folders/${folder.id}/sources`, a, { sourceIds: [source] });
  const started = await call('POST', `/folders/${folder.id}/edit`, a, {});
  expect(started.status).toBe(200);
  const plan = (await started.json()) as { runId: string };
  expect(plan.runId).toBeTruthy();
  expect(
    ((await (await call('POST', `/folders/${folder.id}/edit`, a, {})).json()) as { runId: string }).runId,
  ).toBe(plan.runId);
  expect((await call('POST', `/folders/${folder.id}/style`, a, { styleId: 'nope' })).status).toBe(400);
  expect((await call('GET', `/folders/${folder.id}/plan`, b)).status).toBe(404);
  expect((await call('POST', `/folders/${folder.id}/edit`, b, {})).status).toBe(404);
  expect((await call('POST', `/folders/${folder.id}/style`, b, { styleId: 'sale-fast' })).status).toBe(404);
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
