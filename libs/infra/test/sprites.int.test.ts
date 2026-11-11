import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SpriteIndex, spriteCell, storageKeys } from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FOOTAGE_DIR, footageClip } from '../../../test/footage.js';
import { seedSourceFromFile } from '../../../test/ingest-helpers.js';
import { freshTestDb } from '../../../test/test-db.js';
import { MediaAssetEntity } from '../src/db/entities/media-asset.entity.js';
import { VideoSourceEntity } from '../src/db/entities/video-source.entity.js';
import { seedMerchant } from '../src/db/seed.js';
import { HandlerRegistry } from '../src/jobs/handlers.js';
import { JobRunner } from '../src/jobs/runner.js';
import { probeHandler } from '../src/media/ingest-handlers.js';
import { spritesHandler } from '../src/media/sprites-handler.js';
import { runProcess } from '../src/process/run-process.js';
import { LocalStorage } from '../src/storage/local-storage.js';

const REVIEW = `${FOOTAGE_DIR}/stock/yt-cc/SvoItPQ2-YE.mp4`; // real 6 min 13 s review (MANIFEST S03)
const has = !!footageClip('talkinghead-th-portrait.mp4');

/** SSIM of two images via ffmpeg's stats file. */
async function ssim(a: string, b: string): Promise<number> {
  const log = `${a}.${Math.random().toString(36).slice(2)}.ssim.txt`;
  await runProcess('ffmpeg', [
    '-v',
    'error',
    '-i',
    a,
    '-i',
    b,
    '-lavfi',
    `ssim=stats_file=${log}`,
    '-f',
    'null',
    '-',
  ]);
  const { readFile } = await import('node:fs/promises');
  return Number(/All:([\d.]+)/.exec(await readFile(log, 'utf8'))?.[1] ?? 0);
}

describe.skipIf(!has)('media.sprites on real footage', { timeout: 180_000 }, () => {
  let ds: DataSource;
  let merchantId: string;
  const root = mkdtempSync(join(tmpdir(), 'myvideo-sprites-'));
  const storage = new LocalStorage(join(root, 'storage'));
  beforeAll(async () => {
    ds = await freshTestDb();
    merchantId = (
      await seedMerchant(ds, {
        merchantName: 'A',
        merchantSlug: 'shop-a',
        email: 'a@a.local',
        password: 'password-a',
        displayName: 'A',
      })
    ).merchant.id;
  });
  afterAll(async () => {
    await ds.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  it('index maps seconds to the right frame across sheets and marks the source ready', async () => {
    const runner = new JobRunner(
      ds,
      new HandlerRegistry().register(probeHandler({ ds, storage })).register(spritesHandler({ ds, storage })),
      { workerId: 'w' },
    );
    const s = await seedSourceFromFile(ds, storage, merchantId, REVIEW);
    await ds.query(`UPDATE jobs SET status = 'queued' WHERE id = $1`, [s.jobId]);
    expect(await runner.run(s.jobId)).toBe('succeeded');
    const jobRow = await ds.query(
      `INSERT INTO jobs (merchant_id, workflow_run_id, type, queue, idempotency_key, payload, status, step_index)
       VALUES ($1, $2, 'media.sprites', 'media', $3, $4, 'queued', 3) RETURNING id`,
      [merchantId, s.runId, `t-sprites-${s.sourceId}`, JSON.stringify({ sourceId: s.sourceId })],
    );
    expect(await runner.run(jobRow[0].id)).toBe('succeeded');
    const asset = await ds
      .getRepository(MediaAssetEntity)
      .findOneByOrFail({ sourceId: s.sourceId, kind: 'sprites' });
    const index = asset.meta as unknown as SpriteIndex;
    expect(index).toMatchObject({ count: 374, sheets: 4, tileWidth: 160, tileHeight: 90 });
    expect((await ds.getRepository(VideoSourceEntity).findOneByOrFail({ id: s.sourceId })).status).toBe(
      'ready',
    );

    const work = join(root, 'spot');
    await runProcess('mkdir', ['-p', work]);
    const results: string[] = [];
    for (const t of [7, 99, 100, 215, 372]) {
      const c = spriteCell(index, t);
      const sheet = (
        await storage.localPath(storageKeys.spriteSheet(merchantId, s.sourceId, asset.id, 1, c.sheet))
      ).path;
      const cell = join(work, `cell-${t}.png`);
      await runProcess('ffmpeg', [
        '-v',
        'error',
        '-y',
        '-i',
        sheet,
        '-vf',
        `crop=${index.tileWidth}:${index.tileHeight}:${c.x}:${c.y}`,
        cell,
      ]);
      const scores: Record<string, number> = {};
      for (const off of [-1.5, 0, 1.5]) {
        const tt = Math.min(372.9, Math.max(0, t + off));
        const grab = join(work, `grab-${t}-${off}.png`);
        await runProcess('ffmpeg', [
          '-v',
          'error',
          '-y',
          '-ss',
          String(tt),
          '-i',
          REVIEW,
          '-frames:v',
          '1',
          '-vf',
          `scale=${index.tileWidth}:${index.tileHeight}`,
          grab,
        ]);
        scores[off] = await ssim(cell, grab);
      }
      results.push(`t=${t} sheet=${c.sheet} ${JSON.stringify(scores)}`);
      expect(scores['0'], `t=${t}`).toBeGreaterThan(0.8);
      expect(scores['0'], `t=${t} vs neighbours`).toBeGreaterThanOrEqual(
        Math.max(scores['-1.5'] ?? 0, scores['1.5'] ?? 0) - 0.02,
      );
    }
    console.log(results.join('\n'));
  });
});
