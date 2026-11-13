import { uuidv7 } from '@myvideo/domain';
import { seedMerchant } from '@myvideo/infra';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { freshTestDb } from '../../../test/test-db.js';
import { TimingsService } from '../src/runs/timings.service.js';

let ds: DataSource;
let a: string;
let b: string;
beforeAll(async () => {
  ds = await freshTestDb();
  const merchants = [];
  for (const slug of ['time-a', 'time-b'])
    merchants.push(
      (
        await seedMerchant(ds, {
          merchantName: slug,
          merchantSlug: slug,
          email: `${slug}@test.local`,
          password: 'password-time',
          displayName: slug,
        })
      ).merchant.id,
    );
  [a, b] = merchants as [string, string];
});
afterAll(async () => {
  await ds.destroy();
});
it('clears all this merchant history including active entries, retaining work and underlying records', async () => {
  for (const [merchant, status] of [
    [a, 'succeeded'],
    [a, 'running'],
    [b, 'failed'],
  ] as const)
    await ds.query(
      `INSERT INTO workflow_runs(id,merchant_id,kind,status,input) VALUES($1,$2,'transcribe',$3,$4)`,
      [uuidv7(), merchant, status, JSON.stringify({ product: { name: 'สินค้าจริง' } })],
    );
  const service = new TimingsService(ds);
  expect((await service.list(a, 100)).items).toHaveLength(2);
  expect(await service.clear(a)).toEqual({ cleared: 2 });
  expect((await service.list(a, 100)).items).toEqual([]);
  expect(
    await ds.query(`SELECT status FROM workflow_runs WHERE merchant_id=$1 AND status='running'`, [a]),
  ).toHaveLength(1);
  expect((await service.list(b, 100)).items).toHaveLength(1);
  expect(await ds.query(`SELECT count(*)::int AS n FROM workflow_runs`)).toEqual([{ n: 3 }]);
  expect(
    (await ds.query(`SELECT input->'product' AS product FROM workflow_runs WHERE merchant_id=$1`, [a])).every(
      (r: { product: { name: string } }) => r.product.name === 'สินค้าจริง',
    ),
  ).toBe(true);
  expect(await service.clear(a)).toEqual({ cleared: 0 });
});
