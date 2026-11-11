import { describe, expect, it } from 'vitest';
import { testEnv } from '../../../test/test-env.js';
import { probePostgres, probeRedis } from '../src/health/probes.js';

// Integration: needs ./scripts/dev-services.sh start. Port 1 is never listening → "down" without stopping services.
describe('health probes (real services)', () => {
  it('reports Postgres up', async () => {
    const r = await probePostgres(testEnv().DATABASE_URL);
    expect(r).toMatchObject({ status: 'up' });
  });
  it('reports Redis up', async () => {
    const r = await probeRedis(testEnv().REDIS_URL);
    expect(r).toMatchObject({ status: 'up' });
  });
  it('reports Postgres down with an error, without throwing', async () => {
    const r = await probePostgres('postgresql://127.0.0.1:1/none', 500);
    expect(r.status).toBe('down');
    expect(r.error).toBeTruthy();
  });
  it('reports Redis down quickly, without retrying forever', async () => {
    const r = await probeRedis('redis://127.0.0.1:1', 500);
    expect(r.status).toBe('down');
    expect(r.latencyMs).toBeLessThan(2000);
  });
});
