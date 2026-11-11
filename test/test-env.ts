import { type Env, loadEnv } from '@myvideo/infra';

/** Env for integration tests: real local services, the test database, quiet logs. */
export function testEnv(overrides: Record<string, string> = {}): Env {
  const user = process.env.USER ?? 'postgres';
  return loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? `postgresql://${user}@localhost:5432/myvideo_test`,
    REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
    SESSION_SECRET: 'test-session-secret',
    ...overrides,
  });
}
