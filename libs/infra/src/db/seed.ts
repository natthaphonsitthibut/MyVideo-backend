import type { DataSource } from 'typeorm';
import { hashPassword } from '../auth/password.js';
import { MerchantEntity } from './entities/merchant.entity.js';
import { UserEntity } from './entities/user.entity.js';

export type SeedInput = {
  merchantName: string;
  merchantSlug: string;
  email: string;
  password: string;
  displayName: string;
};

/** Idempotent: creates the merchant and its owner user if missing; never changes an existing password. */
export async function seedMerchant(
  ds: DataSource,
  input: SeedInput,
): Promise<{ merchant: MerchantEntity; user: UserEntity }> {
  return ds.transaction(async (em) => {
    await em
      .createQueryBuilder()
      .insert()
      .into(MerchantEntity)
      .values({ name: input.merchantName, slug: input.merchantSlug })
      .orIgnore()
      .execute();
    const merchant = await em.findOneByOrFail(MerchantEntity, { slug: input.merchantSlug });
    const email = input.email.trim().toLowerCase();
    await em
      .createQueryBuilder()
      .insert()
      .into(UserEntity)
      .values({
        merchantId: merchant.id,
        email,
        passwordHash: await hashPassword(input.password),
        displayName: input.displayName,
        role: 'owner',
      })
      .orIgnore()
      .execute();
    const user = await em.findOneByOrFail(UserEntity, { email });
    if (user.merchantId !== merchant.id) throw new Error(`${email} already belongs to another merchant`);
    return { merchant, user };
  });
}
