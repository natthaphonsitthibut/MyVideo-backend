import { routes } from '@myvideo/contracts';
import { seedMerchant } from '@myvideo/infra';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshTestDb } from '../../../test/test-db.js';
import { testEnv } from '../../../test/test-env.js';
import { createApp } from '../src/app.js';

const A = {
  merchantName: 'ร้าน A',
  merchantSlug: 'shop-a',
  email: 'a@shop-a.local',
  password: 'password-a-123',
  displayName: 'Owner A',
};
const B = {
  merchantName: 'ร้าน B',
  merchantSlug: 'shop-b',
  email: 'b@shop-b.local',
  password: 'password-b-123',
  displayName: 'Owner B',
};

describe('auth + tenant context (real Postgres)', () => {
  let ds: DataSource;
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  const login = async (who: typeof A) => {
    const res = await http.post('/auth/login').send({ email: who.email, password: who.password });
    expect(res.status).toBe(200);
    const cookie = res.headers['set-cookie']?.[0];
    expect(cookie).toBeTruthy();
    return cookie!.split(';')[0]!;
  };

  beforeAll(async () => {
    ds = await freshTestDb();
    await seedMerchant(ds, A);
    await seedMerchant(ds, B);
    app = await createApp(testEnv());
    await app.init();
    http = request(app.getHttpServer());
  });
  afterAll(async () => {
    await app.close();
    await ds.destroy();
  });

  it('rejects every non-public route without a session (401 ApiErrorBody)', async () => {
    for (const r of routes.filter((x) => x.auth)) {
      const res = await http[r.method](r.path.replace(/\{\w+\}/g, '00000000-0000-7000-8000-000000000000'));
      expect(res.status, `${r.method} ${r.path}`).toBe(401);
      expect(res.body).toMatchObject({ statusCode: 401, error: 'unauthorized' });
    }
  });

  it('keeps /health public', async () => {
    // No AI service in this suite → 503 report, but never 401.
    const res = await http.get('/health');
    expect(res.status).not.toBe(401);
    expect(res.body.checks.postgres.status).toBe('up');
  });

  it('refuses wrong passwords and unknown emails with the same answer', async () => {
    const wrong = await http.post('/auth/login').send({ email: A.email, password: 'nope-nope' });
    const unknown = await http.post('/auth/login').send({ email: 'ghost@x.local', password: 'nope-nope' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it('slows down password guessing: the 11th try on one account in 15 min gets 429 with retry-after', async () => {
    const victim = 'guess-me@x.local';
    for (let i = 0; i < 10; i++) {
      const r = await http.post('/auth/login').send({ email: victim, password: `wrong-${i}-xx` });
      expect(r.status).toBe(401);
    }
    const blocked = await http
      .post('/auth/login')
      .send({ email: victim.toUpperCase(), password: 'wrong-x-xx' });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    // another account is unaffected
    expect((await http.post('/auth/login').send({ email: B.email, password: B.password })).status).toBe(200);
  });

  it('validates the login body (400 with field paths)', async () => {
    const res = await http.post('/auth/login').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
    expect(res.body.issues.map((i: { path: string }) => i.path).sort()).toEqual(['email', 'password']);
  });

  it('logs in with an httpOnly SameSite cookie and returns the merchant context', async () => {
    const res = await http.post('/auth/login').send({ email: 'A@Shop-A.local', password: A.password });
    expect(res.status).toBe(200);
    expect(res.body.merchant.slug).toBe('shop-a');
    expect(res.headers['set-cookie']?.[0]).toMatch(
      /^myvideo_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=1209600$/,
    );
  });

  it('scopes /auth/me to the signed-in merchant: B never sees A', async () => {
    const ca = await login(A);
    const cb = await login(B);
    const meA = await http.get('/auth/me').set('Cookie', ca);
    const meB = await http.get('/auth/me').set('Cookie', cb);
    expect(meA.body.merchant.slug).toBe('shop-a');
    expect(meB.body.merchant.slug).toBe('shop-b');
    expect(JSON.stringify(meB.body)).not.toContain('shop-a');
    expect(meB.body.user.email).toBe(B.email);
  });

  it('logout revokes the session server-side', async () => {
    const c = await login(A);
    expect((await http.post('/auth/logout').set('Cookie', c)).status).toBe(204);
    expect((await http.get('/auth/me').set('Cookie', c)).status).toBe(401);
  });

  it('refuses expired and tampered sessions', async () => {
    const c = await login(A);
    expect((await http.get('/auth/me').set('Cookie', `${c.slice(0, -2)}xx`)).status).toBe(401);
    await ds.query(`UPDATE sessions SET expires_at = now() - interval '1 second'`);
    expect((await http.get('/auth/me').set('Cookie', c)).status).toBe(401);
  });

  it('stores only a hash of the session token', async () => {
    const c = await login(B);
    const token = c.split('=')[1]!;
    const rows = (await ds.query('SELECT encode(token_hash, $1) AS h FROM sessions', ['escape'])) as {
      h: string;
    }[];
    expect(rows.some((r) => r.h.includes(token))).toBe(false);
  });

  it('refuses cross-origin state-changing requests', async () => {
    const res = await http
      .post('/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: A.email, password: A.password });
    expect(res.status).toBe(403);
  });
});
