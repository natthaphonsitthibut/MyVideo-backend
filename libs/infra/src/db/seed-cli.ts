// `pnpm db:seed` — one merchant + one owner user for local development.
import { createDataSource } from './data-source.js';
import { seedMerchant } from './seed.js';

const env = process.env;
if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
const password =
  env.SEED_USER_PASSWORD ?? (env.NODE_ENV === 'production' ? undefined : 'myvideo-dev-password');
if (!password) throw new Error('SEED_USER_PASSWORD is required in production');

const ds = await createDataSource(env.DATABASE_URL).initialize();
try {
  const { merchant, user } = await seedMerchant(ds, {
    merchantName: env.SEED_MERCHANT_NAME ?? 'ร้านทดลอง MyVideo',
    merchantSlug: env.SEED_MERCHANT_SLUG ?? 'demo-shop',
    email: env.SEED_USER_EMAIL ?? 'owner@demo.local',
    password,
    displayName: env.SEED_USER_NAME ?? 'Demo Owner',
  });
  console.log(`seeded merchant ${merchant.slug} (${merchant.id}) and user ${user.email}`);
} finally {
  await ds.destroy();
}
