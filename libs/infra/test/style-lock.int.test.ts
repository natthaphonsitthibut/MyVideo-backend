import { uuidv7 } from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { freshTestDb } from '../../../test/test-db.js';
import { seedMerchant } from '../src/db/seed.js';
import { getStyleLock, lockStyle, unlockStyle } from '../src/folders/style-lock.js';

let ds: DataSource;
let a: string;
let b: string;
beforeAll(async () => {
  ds = await freshTestDb();
  const ids: string[] = [];
  for (const slug of ['lock-a', 'lock-b'])
    ids.push(
      (
        await seedMerchant(ds, {
          merchantName: slug,
          merchantSlug: slug,
          email: `${slug}@test.local`,
          password: 'password-lock',
          displayName: slug,
        })
      ).merchant.id,
    );
  [a, b] = ids as [string, string];
});
afterAll(async () => {
  await ds.destroy();
});
it('persists one complete style per merchant, with a stable seed until deliberately replaced', async () => {
  expect(await getStyleLock(ds, a)).toBeNull();
  const first = await lockStyle(ds, a, 'honest-review');
  expect(await getStyleLock(ds, a)).toEqual(first);
  expect(await getStyleLock(ds, b)).toBeNull();
  expect(await lockStyle(ds, a, 'honest-review')).toEqual(first);
  const changed = await lockStyle(ds, a, 'live-hype');
  expect(changed.pack.id).toBe('live-hype');
  expect(changed.seed).not.toBe(first.seed);
  await unlockStyle(ds, b);
  expect(await getStyleLock(ds, a)).toEqual(changed);
  await unlockStyle(ds, a);
  expect(await getStyleLock(ds, a)).toBeNull();
  expect(await getStyleLock(ds, uuidv7())).toBeNull();
});
