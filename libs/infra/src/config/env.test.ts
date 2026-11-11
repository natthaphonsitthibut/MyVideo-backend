import { describe, expect, it } from 'vitest';
import { EnvError, loadEnv } from './env.js';

const base = {
  DATABASE_URL: 'postgresql://localhost:5432/myvideo_dev',
  REDIS_URL: 'redis://localhost:6379',
  SESSION_SECRET: 'a-long-enough-secret',
};

describe('loadEnv', () => {
  it('applies safe defaults for the dev machine', () => {
    const env = loadEnv(base);
    expect(env.PORT).toBe(3000);
    expect(env.LLM_MODE).toBe('rules');
    expect(env.QUEUE_RENDER_CONCURRENCY).toBe(1);
    expect(env.LLM_API_KEY).toBeUndefined();
  });

  it('treats empty strings from .env.example as unset', () => {
    const env = loadEnv({ ...base, LLM_PROVIDER: '', S3_BUCKET: '  ' });
    expect(env.LLM_PROVIDER).toBeUndefined();
    expect(env.S3_BUCKET).toBeUndefined();
  });

  it('coerces numbers and rejects bad ones by variable name', () => {
    expect(loadEnv({ ...base, PORT: '4100' }).PORT).toBe(4100);
    expect(() => loadEnv({ ...base, PORT: 'abc' })).toThrow(/PORT/);
  });

  it('requires DATABASE_URL and REDIS_URL', () => {
    expect(() => loadEnv({ SESSION_SECRET: 'a-long-enough-secret' })).toThrow(/DATABASE_URL[\s\S]*REDIS_URL/);
  });

  it('refuses local-agent mode in production', () => {
    expect(() =>
      loadEnv({
        ...base,
        NODE_ENV: 'production',
        LLM_MODE: 'local-agent',
        SESSION_SECRET: 'prod-secret-123',
      }),
    ).toThrow(/local-agent/);
  });

  it('needs a provider and key for api mode', () => {
    expect(() => loadEnv({ ...base, LLM_MODE: 'api' })).toThrow(/LLM_PROVIDER/);
    expect(loadEnv({ ...base, LLM_MODE: 'api', LLM_PROVIDER: 'x', LLM_API_KEY: 'k' }).LLM_MODE).toBe('api');
  });

  it('never puts a value into the error message', () => {
    try {
      loadEnv({ ...base, SESSION_SECRET: 'short' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EnvError);
      expect((err as Error).message).toContain('SESSION_SECRET');
      expect((err as Error).message).not.toContain('short\n');
    }
  });
});
