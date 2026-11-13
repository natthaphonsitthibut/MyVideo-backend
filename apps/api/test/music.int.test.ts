import type { AddressInfo } from 'node:net';
import { seedMerchant } from '@myvideo/infra';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { freshTestDb } from '../../../test/test-db.js';
import { testEnv } from '../../../test/test-env.js';
import { createApp } from '../src/app.js';
import { loginCookie } from './helpers.js';

let ds: DataSource, app: INestApplication, base: string, a: string, b: string;
beforeAll(async () => {
  ds = await freshTestDb();
  for (const slug of ['music-a', 'music-b'])
    await seedMerchant(ds, {
      merchantName: slug,
      merchantSlug: slug,
      email: `${slug}@test.local`,
      password: 'password-music',
      displayName: slug,
    });
  app = await createApp(testEnv());
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  a = await loginCookie(app, 'music-a@test.local', 'password-music');
  b = await loginCookie(app, 'music-b@test.local', 'password-music');
});
afterAll(async () => {
  await app.close();
  await ds.destroy();
});
it('stores rights information, queues analysis without decoding media in the request, and isolates merchants', async () => {
  const upload = await fetch(`${base}/music?title=plumbing.wav&license=internal-test-only`, {
    method: 'POST',
    headers: { cookie: a, origin: base, 'content-type': 'audio/wav' },
    body: Buffer.from('plumbing only — no real audio'),
  });
  expect(upload.status).toBe(202);
  const row = (await upload.json()) as { id: string; status: string; license: string };
  expect(row).toMatchObject({ status: 'processing', license: 'internal-test-only' });
  expect(await ds.query("SELECT type FROM jobs WHERE payload->>'musicId'=$1", [row.id])).toEqual([
    { type: 'music.analyse' },
  ]);
  const foreign = await fetch(`${base}/music`, { headers: { cookie: b } });
  expect(await foreign.json()).toEqual({ items: [] });
  expect((await fetch(`${base}/music/${row.id}/file`, { headers: { cookie: b } })).status).toBe(404);
  expect((await fetch(`${base}/music`)).status).toBe(401);
});
