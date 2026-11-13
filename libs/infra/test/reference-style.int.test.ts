import { uuidv7 } from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { freshTestDb } from '../../../test/test-db.js';
import { seedMerchant } from '../src/db/seed.js';
import { getStyleLock, lockStyle } from '../src/folders/style-lock.js';
import { grammarPack, measureGrammar } from '../src/reference/reference-grammar.js';
import {
  createReference,
  customStyles,
  enqueueReferenceForSource,
} from '../src/reference/reference-store.js';

let ds: DataSource, a: string, b: string, sourceId: string;
beforeAll(async () => {
  ds = await freshTestDb();
  const ids: string[] = [];
  for (const slug of ['reference-a', 'reference-b'])
    ids.push(
      (
        await seedMerchant(ds, {
          merchantName: slug,
          merchantSlug: slug,
          email: `${slug}@test.local`,
          password: 'password-reference',
          displayName: slug,
        })
      ).merchant.id,
    );
  [a, b] = ids as [string, string];
  sourceId = uuidv7();
  await ds.query(
    `INSERT INTO video_sources(id,merchant_id,upload_id,title,original_filename,status,size_bytes,sha256)VALUES($1::uuid,$2,$1::text,'reference plumbing','reference.mp4','processing',1,$3)`,
    [sourceId, a, '0'.repeat(64)],
  );
});
afterAll(async () => {
  await ds.destroy();
});
it('waits durably for ingest, queues once when ready, scopes references and locks grammar without reference content', async () => {
  const id = await createReference(ds, a, sourceId, 'Measured style');
  expect(await createReference(ds, a, sourceId, 'Same upload')).toBe(id);
  expect(await ds.query("SELECT id FROM jobs WHERE type='reference.analyse'")).toEqual([]);
  await expect(createReference(ds, b, sourceId, 'Foreign')).rejects.toThrow('ไม่พบคลิป');
  await ds.query("UPDATE video_sources SET status='ready' WHERE id=$1", [sourceId]);
  await ds.transaction(async (em) => {
    await enqueueReferenceForSource(em, sourceId, a);
    await enqueueReferenceForSource(em, sourceId, a);
  });
  expect((await ds.query("SELECT id FROM jobs WHERE type='reference.analyse'")).length).toBe(1);
  // Numeric plumbing inputs only; no media quality claim, file decoding or model invocation.
  const grammar = measureGrammar(10000, [0, 2000, 4000, 10000], ['#123456'], [], null),
    snapshot = grammarPack(id, 'Measured style', grammar);
  await ds.query("UPDATE reference_styles SET status='ready',grammar=$2,snapshot=$3 WHERE id=$1", [
    id,
    JSON.stringify(grammar),
    JSON.stringify(snapshot),
  ]);
  expect(await customStyles(ds, b)).toEqual([]);
  expect(await lockStyle(ds, a, snapshot.pack.id)).toEqual(snapshot);
  expect(await getStyleLock(ds, b)).toBeNull();
  expect((await customStyles(ds, a))[0]).toEqual(snapshot);
  const foreign = uuidv7();
  await ds.query(
    `INSERT INTO video_sources(id,merchant_id,upload_id,title,original_filename,status,size_bytes,sha256)VALUES($1::uuid,$2,$1::text,'foreign','foreign.mp4','ready',1,$3)`,
    [foreign, b, '0'.repeat(64)],
  );
  await expect(
    ds.query(
      `INSERT INTO reference_styles(merchant_id,source_id,title,run_id)VALUES($1,$2,'cross-tenant',$3)`,
      [a, foreign, uuidv7()],
    ),
  ).rejects.toThrow();
});
