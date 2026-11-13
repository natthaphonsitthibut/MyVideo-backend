import { uuidv7 } from '@myvideo/domain';
import { seedMerchant } from '@myvideo/infra';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { freshTestDb } from '../../../test/test-db.js';
import { SourcesService } from '../src/sources/sources.service.js';

let ds: DataSource;
let merchantId: string;
let sources: SourcesService;
beforeAll(async () => {
  ds = await freshTestDb();
  merchantId = (
    await seedMerchant(ds, {
      merchantName: 'Media',
      merchantSlug: 'media',
      email: 'media@test.local',
      password: 'password-media',
      displayName: 'Media',
    })
  ).merchant.id;
  sources = new SourcesService(ds, {} as never, {} as never, {} as never);
  for (const [filename, still] of [
    ['photo.png', true],
    ['video.mp4', false],
    ['pending.JPG', null],
    ['video2.mov', false],
  ] as const)
    await ds.query(
      `INSERT INTO video_sources(id,merchant_id,upload_id,title,original_filename,size_bytes,sha256,status,probe) VALUES($1,$2,$3,$4,$4,1,'hash',$5,$6)`,
      [
        uuidv7(),
        merchantId,
        uuidv7(),
        filename,
        still === null ? 'processing' : 'ready',
        still === null ? null : JSON.stringify({ still }),
      ],
    );
});
afterAll(async () => {
  await ds.destroy();
});
it('filters before paginating and includes pending photos without mixing video results', async () => {
  const first = await sources.list(merchantId, 1, undefined, 'photo');
  expect(first.items).toHaveLength(1);
  expect(first.items[0]?.kind).toBe('photo');
  expect(first.nextCursor).not.toBeNull();
  const second = await sources.list(merchantId, 1, first.nextCursor ?? undefined, 'photo');
  expect(second.items).toHaveLength(1);
  expect(second.items[0]?.kind).toBe('photo');
  expect(second.nextCursor).toBeNull();
  expect(first.items[0]?.id).not.toBe(second.items[0]?.id);
  const videos = await sources.list(merchantId, 100, undefined, 'video');
  expect(videos.items.map((s) => s.kind)).toEqual(['video', 'video']);
  expect((await sources.list(uuidv7(), 100, undefined, 'photo')).items).toEqual([]);
});
