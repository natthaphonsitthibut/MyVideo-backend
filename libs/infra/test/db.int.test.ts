import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshTestDb } from '../../../test/test-db.js';
import { verifyPassword } from '../src/auth/password.js';
import { MerchantEntity } from '../src/db/entities/merchant.entity.js';
import { UserEntity } from '../src/db/entities/user.entity.js';
import { migrations } from '../src/db/migrations/index.js';
import { seedMerchant } from '../src/db/seed.js';

const tables = async (ds: DataSource) =>
  (
    (await ds.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`,
    )) as { table_name: string }[]
  ).map((r) => r.table_name);

describe('database baseline (real Postgres, test database)', () => {
  let ds: DataSource;
  beforeAll(async () => {
    ds = await freshTestDb();
  });
  afterAll(async () => {
    await ds.destroy();
  });

  it('migrates up, down to empty, and up again', async () => {
    expect(await tables(ds)).toEqual([
      'job_attempts',
      'jobs',
      'merchants',
      'sessions',
      'typeorm_migrations',
      'users',
      'workflow_runs',
    ]);
    for (let i = 0; i < migrations.length; i++) await ds.undoLastMigration();
    expect(await tables(ds)).toEqual(['typeorm_migrations']);
    await ds.runMigrations();
    expect(await tables(ds)).toEqual([
      'job_attempts',
      'jobs',
      'merchants',
      'sessions',
      'typeorm_migrations',
      'users',
      'workflow_runs',
    ]);
  });

  it('has no drift between entities and migrations', async () => {
    const pending = await ds.driver.createSchemaBuilder().log();
    expect(pending.upQueries.map((q) => q.query)).toEqual([]);
  });

  it('indexes every foreign key column', async () => {
    const unindexed = await ds.query(`
      SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f' AND NOT EXISTS (
        SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = a.attnum)`);
    expect(unindexed).toEqual([]);
  });

  it('seeds idempotently and reads back through a repository', async () => {
    const input = {
      merchantName: 'ร้านทดสอบ',
      merchantSlug: 'test-shop',
      email: 'Owner@Test.local',
      password: 'test-password-1',
      displayName: 'Owner',
    };
    const first = await seedMerchant(ds, input);
    const second = await seedMerchant(ds, { ...input, password: 'other-password' });
    expect(second.user.id).toBe(first.user.id);
    const user = await ds.getRepository(UserEntity).findOneByOrFail({ email: 'owner@test.local' });
    expect(user.merchantId).toBe(first.merchant.id);
    expect(await verifyPassword('test-password-1', user.passwordHash)).toBe(true);
    // UUIDv7: version nibble is 7
    expect(user.id[14]).toBe('7');
  });

  it('enforces constraints in the database', async () => {
    const merchants = ds.getRepository(MerchantEntity);
    await expect(merchants.insert({ name: '  ', slug: 'blank-name' })).rejects.toThrow(
      /merchants_name_not_blank/,
    );
    await expect(merchants.insert({ name: 'x', slug: 'Bad Slug' })).rejects.toThrow(/merchants_slug_format/);
    const m = await merchants.findOneByOrFail({ slug: 'test-shop' });
    const users = ds.getRepository(UserEntity);
    const row = { merchantId: m.id, passwordHash: 'x', displayName: 'x' };
    await expect(users.insert({ ...row, email: 'UPPER@x.local' })).rejects.toThrow(/users_email_lowercase/);
    await expect(users.insert({ ...row, email: 'owner@test.local' })).rejects.toThrow(/users_email_key/);
    await expect(
      users.insert({ ...row, email: 'ghost@x.local', merchantId: '01900000-0000-7000-8000-000000000000' }),
    ).rejects.toThrow(/users_merchant_id_fkey/);
  });

  it('cascades user deletion with the merchant', async () => {
    const m = await ds.getRepository(MerchantEntity).findOneByOrFail({ slug: 'test-shop' });
    await ds.getRepository(MerchantEntity).delete(m.id);
    expect(await ds.getRepository(UserEntity).countBy({ merchantId: m.id })).toBe(0);
  });
});
