import { createDataSource } from '@myvideo/infra';
import type { DataSource } from 'typeorm';
import { testEnv } from './test-env.js';

/** Drops everything in the test database and runs all migrations from zero. */
export async function freshTestDb(): Promise<DataSource> {
  const ds = await createDataSource(testEnv().DATABASE_URL).initialize();
  await ds.query('DROP SCHEMA public CASCADE');
  await ds.query('CREATE SCHEMA public');
  await ds.runMigrations();
  return ds;
}
