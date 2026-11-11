import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startAiService } from '../../../test/ai-service.js';
import { testEnv } from '../../../test/test-env.js';
import { createApp } from '../src/app.js';

describe('GET /health (real Postgres + Redis + AI service)', () => {
  let app: INestApplication | undefined;
  let ai: Awaited<ReturnType<typeof startAiService>>;
  beforeAll(async () => {
    ai = await startAiService(18_766);
  }, 60_000);
  afterAll(() => ai?.stop());
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('returns 200 ok when Postgres and Redis are up', async () => {
    app = await createApp(testEnv({ AI_SERVICE_URL: ai.url }));
    await app.init();
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      checks: { postgres: { status: 'up' }, redis: { status: 'up' }, ai: { status: 'up' } },
    });
  });

  it('returns 503 and names redis as down when Redis is unreachable', async () => {
    app = await createApp(testEnv({ AI_SERVICE_URL: ai.url, REDIS_URL: 'redis://127.0.0.1:1' }));
    await app.init();
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks.redis.status).toBe('down');
    expect(res.body.checks.postgres.status).toBe('up');
  });

  it('returns 503 and names ai as down when the AI service is unreachable', async () => {
    app = await createApp(testEnv({ AI_SERVICE_URL: 'http://127.0.0.1:1' }));
    await app.init();
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.checks.ai.status).toBe('down');
    expect(res.body.checks.redis.status).toBe('up');
  });

  it('echoes a valid x-request-id and creates one otherwise', async () => {
    app = await createApp(testEnv({ AI_SERVICE_URL: ai.url }));
    await app.init();
    const given = await request(app.getHttpServer()).get('/health').set('x-request-id', 'abc-123');
    expect(given.headers['x-request-id']).toBe('abc-123');
    const made = await request(app.getHttpServer()).get('/health').set('x-request-id', 'bad id with spaces');
    expect(made.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
