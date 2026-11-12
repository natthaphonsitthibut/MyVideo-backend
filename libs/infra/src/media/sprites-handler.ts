import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { type SpriteIndex, type StoragePort, storageKeys } from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import { MediaAssetEntity } from '../db/entities/media-asset.entity.js';
import { FatalJobError, type JobHandler } from '../jobs/handlers.js';
import { runProcess, withTempDir } from '../process/run-process.js';
import type { ProbeInfo } from './probe.js';
import { loadSource, markSourceFailed } from './source-helpers.js';

export const SPRITES_RECIPE = 1;
export const SPRITE_COLS = 10;
export const SPRITE_ROWS = 10;
export const SPRITE_TILE_WIDTH = 160;

/** Tile height for a display size, even, keeping aspect. */
export const tileHeightFor = (width: number, height: number) =>
  Math.max(2, Math.round((SPRITE_TILE_WIDTH * height) / width / 2) * 2);

/** ffmpeg arguments for sheet `n`: tile i = the frame AT second (n·100 + i) (`round=up`, verified by SSIM). */
export function sheetArgs(input: string, sheet: number, tileHeight: number, out: string): string[] {
  const perSheet = SPRITE_COLS * SPRITE_ROWS;
  return [
    '-v',
    'error',
    '-y',
    '-nostdin',
    '-ss',
    String(sheet * perSheet),
    '-t',
    String(perSheet),
    '-i',
    input,
    '-an',
    '-vf',
    `fps=1:start_time=0:round=up,scale=${SPRITE_TILE_WIDTH}:${tileHeight},tile=${SPRITE_COLS}x${SPRITE_ROWS}`,
    '-frames:v',
    '1',
    '-q:v',
    '5',
    out,
  ];
}

/**
 * Step 4 (last) of ingest: thumbnail sprite sheets (1 tile per second, 10×10 per sheet) + index JSON. Long files
 * are done one sheet at a time (resumable: a retry skips sheets already stored). Marks the source `ready`.
 */
export function spritesHandler({ ds, storage }: { ds: DataSource; storage: StoragePort }): JobHandler {
  return {
    type: 'media.sprites',
    queue: 'media',
    async run({ job, signal, progress }) {
      const { source, original } = await loadSource(ds, job);
      const probe = source.probe as ProbeInfo | null;
      if (!probe) throw new FatalJobError('source has no probe result');
      const assetId = job.id; // stable across retries → sheet keys are stable
      const existing = await ds
        .getRepository(MediaAssetEntity)
        .findOneBy({ sourceId: source.id, kind: 'sprites', recipeVersion: SPRITES_RECIPE });
      if (!existing) {
        const count = Math.max(1, Math.ceil(probe.durationMs / 1000));
        const perSheet = SPRITE_COLS * SPRITE_ROWS;
        const sheets = Math.ceil(count / perSheet);
        const index: SpriteIndex = {
          version: 1,
          intervalSec: 1,
          cols: SPRITE_COLS,
          rows: SPRITE_ROWS,
          tileWidth: SPRITE_TILE_WIDTH,
          tileHeight: tileHeightFor(probe.video.width, probe.video.height),
          count,
          sheets,
          durationMs: probe.durationMs,
        };
        const input = await storage.localPath(original.storageKey);
        try {
          await withTempDir('sprites', async (dir) => {
            for (let n = 0; n < sheets; n++) {
              const key = storageKeys.spriteSheet(job.merchantId, source.id, assetId, SPRITES_RECIPE, n);
              if (!(await storage.stat(key))) {
                const out = join(dir, `sheet-${n}.jpg`);
                await runProcess('ffmpeg', sheetArgs(input.path, n, index.tileHeight, out), {
                  signal,
                  timeoutMs: 10 * 60_000,
                });
                await storage.put(key, createReadStream(out), { contentType: 'image/jpeg' });
              }
              await progress((n + 1) / sheets);
            }
          });
        } finally {
          await input.release();
        }
        const key = storageKeys.derived(
          job.merchantId,
          source.id,
          assetId,
          'sprites',
          SPRITES_RECIPE,
          'json',
        );
        const stored = await storage.put(key, Buffer.from(JSON.stringify(index)), {
          contentType: 'application/json',
        });
        await ds.query(
          `INSERT INTO media_assets (id, merchant_id, source_id, kind, recipe_version, storage_key, size_bytes, sha256, content_type, meta)
           VALUES ($1, $2, $3, 'sprites', $4, $5, $6, $7, 'application/json', $8)
           ON CONFLICT (source_id, kind, recipe_version) DO NOTHING`,
          [
            assetId,
            job.merchantId,
            source.id,
            SPRITES_RECIPE,
            key,
            stored.size,
            stored.sha256,
            JSON.stringify(index),
          ],
        );
      }
      // all ingest outputs exist → the source is browsable
      await ds.query(
        `UPDATE video_sources SET status = 'ready', failure_reason = NULL, updated_at = now() WHERE id = $1 AND merchant_id = $2`,
        [source.id, job.merchantId],
      );
      return { assetId: existing?.id ?? assetId, reused: !!existing };
    },
    onDead: markSourceFailed,
  };
}
