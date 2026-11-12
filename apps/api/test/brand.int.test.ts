import type { AddressInfo } from 'node:net';
import type { BrandKit } from '@myvideo/contracts';
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

// a real 1×1 PNG (plumbing: the bytes, type sniffing and storage round trip)
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('brand kit API (E08-F08)', () => {
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let cookieA: string;
  let cookieB: string;

  beforeAll(async () => {
    ds = await freshTestDb();
    await seedMerchant(ds, A);
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

  const call = (method: string, path: string, cookie: string, body?: unknown, type = 'application/json') =>
    fetch(`${base}${path}`, {
      method,
      headers: { cookie, origin: base, 'content-type': type },
      body: body === undefined ? undefined : body instanceof Buffer ? body : JSON.stringify(body),
    });

  it('defaults, save, per-merchant isolation, validation', async () => {
    expect((await call('GET', '/brand-kit', '')).status).toBe(401);
    const first = (await (await call('GET', '/brand-kit', cookieA)).json()) as BrandKit;
    expect(first).toMatchObject({ primaryColor: '#111111', hasLogo: false, updatedAt: null });

    const saved = await call('PUT', '/brand-kit', cookieA, {
      primaryColor: '#e11d48',
      accentColor: '#fde047',
      textColor: '#ffffff',
      font: 'noto-sans-thai',
      defaultCta: ' ทักแชทสั่งได้เลย ',
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ primaryColor: '#e11d48', defaultCta: 'ทักแชทสั่งได้เลย' });
    // saving again updates the same row
    await call('PUT', '/brand-kit', cookieA, {
      primaryColor: '#2563eb',
      accentColor: '#fde047',
      textColor: '#ffffff',
      font: 'noto-sans-thai',
      defaultCta: 'ทักแชทสั่งได้เลย',
    });
    expect(await ds.query(`SELECT count(*)::int AS n FROM brand_kits`)).toEqual([{ n: 1 }]);
    expect(((await (await call('GET', '/brand-kit', cookieA)).json()) as BrandKit).primaryColor).toBe(
      '#2563eb',
    );
    // merchant B still sees the defaults
    expect(((await (await call('GET', '/brand-kit', cookieB)).json()) as BrandKit).primaryColor).toBe(
      '#111111',
    );

    const bad = await call('PUT', '/brand-kit', cookieA, {
      primaryColor: 'red',
      accentColor: '#fde047',
      textColor: '#ffffff',
      font: 'noto-sans-thai',
      defaultCta: 'x',
    });
    expect(bad.status).toBe(400);
  });

  it('logo: sniffed type, size cap, served only to its merchant', async () => {
    expect((await call('GET', '/brand-kit/logo', cookieA)).status).toBe(404);
    const notImage = await call('PUT', '/brand-kit/logo', cookieA, Buffer.from('hello'), 'image/png');
    expect(notImage.status).toBe(415);
    const tooBig = await call(
      'PUT',
      '/brand-kit/logo',
      cookieA,
      Buffer.alloc(2 * 1024 * 1024 + 1),
      'image/png',
    );
    expect(tooBig.status).toBe(413);

    const up = await call('PUT', '/brand-kit/logo', cookieA, PNG, 'image/png');
    expect(up.status).toBe(200);
    expect(((await up.json()) as BrandKit).hasLogo).toBe(true);
    const logo = await call('GET', '/brand-kit/logo', cookieA);
    expect(logo.status).toBe(200);
    expect(logo.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await logo.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await call('GET', '/brand-kit/logo', cookieB)).status).toBe(404);
  });
});
