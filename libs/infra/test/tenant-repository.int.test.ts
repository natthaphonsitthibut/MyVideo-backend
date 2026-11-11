import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshTestDb } from '../../../test/test-db.js';
import { UserEntity } from '../src/db/entities/user.entity.js';
import { seedMerchant } from '../src/db/seed.js';
import { TenantRepository } from '../src/db/tenant/tenant-repository.js';

describe('TenantRepository (real Postgres)', () => {
  let ds: DataSource;
  let a: { merchantId: string; userId: string };
  let b: { merchantId: string; userId: string };
  beforeAll(async () => {
    ds = await freshTestDb();
    const sa = await seedMerchant(ds, {
      merchantName: 'A',
      merchantSlug: 'shop-a',
      email: 'a@a.local',
      password: 'password-a',
      displayName: 'A',
    });
    const sb = await seedMerchant(ds, {
      merchantName: 'B',
      merchantSlug: 'shop-b',
      email: 'b@b.local',
      password: 'password-b',
      displayName: 'B',
    });
    a = { merchantId: sa.merchant.id, userId: sa.user.id };
    b = { merchantId: sb.merchant.id, userId: sb.user.id };
  });
  afterAll(async () => ds.destroy());

  const repo = (merchantId: string) => new TenantRepository(ds.manager, UserEntity, merchantId);

  it('lists and counts only the merchant own rows', async () => {
    expect((await repo(a.merchantId).find()).map((u) => u.email)).toEqual(['a@a.local']);
    expect(await repo(b.merchantId).count()).toBe(1);
  });

  it('treats another merchant row as missing', async () => {
    expect(await repo(a.merchantId).findById(b.userId)).toBeNull();
    expect(await repo(a.merchantId).findOne({ email: 'b@b.local' })).toBeNull();
    expect(await repo(b.merchantId).findById(b.userId)).not.toBeNull();
  });

  it('cannot update or delete another merchant row', async () => {
    expect(await repo(a.merchantId).update({ id: b.userId }, { displayName: 'hacked' })).toBe(0);
    expect(await repo(a.merchantId).delete({ id: b.userId })).toBe(0);
    const still = await ds.getRepository(UserEntity).findOneByOrFail({ id: b.userId });
    expect(still.displayName).toBe('B');
  });

  it('stamps its own merchantId on insert, ignoring any other', async () => {
    const row = await repo(a.merchantId).insert({
      email: 'second@a.local',
      passwordHash: 'x',
      displayName: 'Second',
      ...({ merchantId: b.merchantId } as object),
    });
    expect(row.merchantId).toBe(a.merchantId);
  });

  it('refuses to move a row to another merchant', async () => {
    await expect(
      repo(a.merchantId).update({ id: a.userId }, { merchantId: b.merchantId } as never),
    ).rejects.toThrow(/merchantId cannot be changed/);
  });

  it('requires a merchant id', () => {
    expect(() => new TenantRepository(ds.manager, UserEntity, '')).toThrow();
  });
});
