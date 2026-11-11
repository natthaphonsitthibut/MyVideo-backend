import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { testEnv } from '../../../test/test-env.js';
import { createApp } from '../src/app.js';

describe('GET /health (real Postgres + Redis)', () => {
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('returns 200 ok when Postgres and Redis are up', async () => {
    app = await createApp(testEnv());
    await app.init();
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      checks: { postgres: { status: 'up' }, redis: { status: 'up' } },
    });
  });

  it('returns 503 and names redis as down when Redis is unreachable', async () => {
    app = await createApp(testEnv({ REDIS_URL: 'redis://127.0.0.1:1' }));
    await app.init();
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.redis.status).toBe('down');
    expect(res.body.checks.postgres.status).toBe('up');
  });

  it('echoes a valid x-request-id and creates one otherwise', async () => {
    app = await createApp(testEnv());
    await app.init();
    const given = await request(app.getHttpServer()).get('/health').set('x-request-id', 'abc-123');
    expect(given.headers['x-request-id']).toBe('abc-123');
    const made = await request(app.getHttpServer()).get('/health').set('x-request-id', 'bad id with spaces');
    expect(made.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
