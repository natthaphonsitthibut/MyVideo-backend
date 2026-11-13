import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type StoragePort, storageKeys, uuidv7 } from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import { MediaAssetEntity } from '../db/entities/media-asset.entity.js';
import { FatalJobError, type JobHandler } from '../jobs/handlers.js';
import { ffmpegProgressParser, runProcess, withTempDir } from '../process/run-process.js';
import { type ProbeInfo, probeFile } from './probe.js';
import {
  audioArgs,
  concatArgs,
  PROXY_FPS,
  PROXY_RECIPE,
  type ProxyEncoder,
  planSegments,
  segmentArgs,
} from './proxy.js';
import { loadSource, markSourceFailed } from './source-helpers.js';

export type ProxyDeps = {
  ds: DataSource;
  storage: StoragePort;
  encoder: ProxyEncoder;
  segmentSeconds: number;
};

/**
 * Step 2 of ingest: the 540p / 30 fps / GOP 15 preview proxy (media-pipeline recipe). Long inputs are encoded
 * in parts that are saved to storage as they finish, so a retry after a crash only redoes the missing parts.
 * Output is validated with ffprobe before it is recorded. Idempotent: an existing proxy asset is reused.
 */
export function proxyHandler({ ds, storage, encoder, segmentSeconds }: ProxyDeps): JobHandler {
  return {
    type: 'media.proxy',
    queue: 'media',
    async run({ job, signal, progress }) {
      const { source, original } = await loadSource(ds, job);
      const existing = await ds
        .getRepository(MediaAssetEntity)
        .findOneBy({ sourceId: source.id, kind: 'proxy', recipeVersion: PROXY_RECIPE });
      if (existing) return { assetId: existing.id, reused: true };
      const probe = source.probe as ProbeInfo | null;
      if (!probe) throw new FatalJobError('source has no probe result');
      const duration = probe.durationMs / 1000;
      const segments = planSegments(duration, segmentSeconds);
      const partKey = (i: number) =>
        `${storageKeys.merchantPrefix(job.merchantId)}sources/${source.id}/derived/work-${job.id}/part-${String(i).padStart(3, '0')}.mp4`;
      const input = await storage.localPath(original.storageKey);
      const started = Date.now();
      try {
        return await withTempDir('proxy', async (dir) => {
          // 1. video parts (resumable)
          let reused = 0;
          for (const seg of segments) {
            const key = partKey(seg.index);
            if (await storage.stat(key)) {
              reused++;
              continue;
            }
            const out = join(dir, `part-${seg.index}.mp4`);
            await runProcess('ffmpeg', segmentArgs(input.path, seg, out, encoder, probe.still === true), {
              signal,
              onStdoutLine: ffmpegProgressParser(
                (s) => void progress((0.85 * (seg.start + Math.min(s, seg.duration))) / duration),
              ),
            });
            await storage.put(key, createReadStream(out), { contentType: 'video/mp4' });
          }
          // 2. audio in one pass
          let audio: string | null = null;
          if (probe.audio) {
            audio = join(dir, 'audio.m4a');
            await runProcess('ffmpeg', audioArgs(input.path, audio), { signal });
          }
          await progress(0.9);
          // 3. join + faststart
          const parts = await Promise.all(segments.map((s) => storage.localPath(partKey(s.index))));
          const list = join(dir, 'parts.txt');
          await writeFile(list, parts.map((p) => `file '${p.path.replaceAll("'", "'\\''")}'`).join('\n'));
          const out = join(dir, 'proxy.mp4');
          await runProcess('ffmpeg', concatArgs(list, audio, out), { signal });
          for (const p of parts) await p.release();
          // 4. validate before recording (media-pipeline rule 5)
          const check = await probeFile(out, { signal });
          if (!check.ok) throw new Error(`proxy validation failed: ${check.reason}`);
          const drift = Math.abs(check.info.durationMs - probe.durationMs);
          if (drift > Math.max(200, 3000 / PROXY_FPS)) throw new Error(`proxy duration off by ${drift} ms`);
          if (check.info.video.fps.num / check.info.video.fps.den !== PROXY_FPS)
            throw new Error('proxy is not 30 fps');
          if (!!probe.audio !== !!check.info.audio)
            throw new Error('proxy audio presence differs from the source');
          // 5. store + record atomically (recipe version in the key and the row)
          const assetId = uuidv7();
          const key = storageKeys.derived(job.merchantId, source.id, assetId, 'proxy', PROXY_RECIPE, 'mp4');
          const stored = await storage.put(key, createReadStream(out), { contentType: 'video/mp4' });
          const meta = {
            width: check.info.video.width,
            height: check.info.video.height,
            fps: check.info.video.fps,
            durationMs: check.info.durationMs,
            encoder,
            segments: segments.length,
            reusedSegments: reused,
            encodeMs: Date.now() - started,
          };
          const inserted: { id: string }[] = await ds.query(
            `INSERT INTO media_assets (id, merchant_id, source_id, kind, recipe_version, storage_key, size_bytes, sha256, content_type, meta)
             VALUES ($1, $2, $3, 'proxy', $4, $5, $6, $7, 'video/mp4', $8)
             ON CONFLICT (source_id, kind, recipe_version) DO NOTHING RETURNING id`,
            [
              assetId,
              job.merchantId,
              source.id,
              PROXY_RECIPE,
              key,
              stored.size,
              stored.sha256,
              JSON.stringify(meta),
            ],
          );
          if (inserted.length === 0) await storage.delete(key); // another attempt won the race
          for (const s of segments) await storage.delete(partKey(s.index));
          return { assetId, ...meta };
        });
      } finally {
        await input.release();
      }
    },
    next: (job) => [
      {
        type: 'media.audio',
        queue: 'media',
        payload: { sourceId: job.payload.sourceId },
        timeoutMs: 3600_000,
      },
    ],
    onDead: markSourceFailed,
  };
}
