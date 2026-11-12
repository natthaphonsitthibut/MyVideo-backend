import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { type StoragePort, storageKeys, uuidv7 } from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import { MediaAssetEntity } from '../db/entities/media-asset.entity.js';
import { FatalJobError, type JobHandler } from '../jobs/handlers.js';
import { runProcess, withTempDir } from '../process/run-process.js';
import { noAudioPeaks, PEAKS_RECIPE, PeaksBuilder, type PeaksJson } from './peaks.js';
import type { ProbeInfo } from './probe.js';
import { loadSource, markSourceFailed } from './source-helpers.js';

export const AUDIO_RECIPE = 1;
const PEAK_RATE = 8000;

async function recordAsset(
  ds: DataSource,
  row: {
    id: string;
    merchantId: string;
    sourceId: string;
    kind: 'audio' | 'peaks';
    recipe: number;
    key: string;
    size: number;
    sha256: string;
    contentType: string;
    meta: Record<string, unknown>;
  },
): Promise<boolean> {
  const res: { id: string }[] = await ds.query(
    `INSERT INTO media_assets (id, merchant_id, source_id, kind, recipe_version, storage_key, size_bytes, sha256, content_type, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (source_id, kind, recipe_version) DO NOTHING RETURNING id`,
    [
      row.id,
      row.merchantId,
      row.sourceId,
      row.kind,
      row.recipe,
      row.key,
      row.size,
      row.sha256,
      row.contentType,
      JSON.stringify(row.meta),
    ],
  );
  return res.length > 0;
}

/**
 * Step 3 of ingest: 16 kHz mono FLAC for ASR and multi-resolution waveform peaks, from ONE ffmpeg pass. Peaks are
 * reduced from streamed 8 kHz PCM (never the whole file in memory). No audio stream → flat peaks flagged
 * `hasAudio: false`, no FLAC. Idempotent per (source, kind, recipe).
 */
export function audioHandler({ ds, storage }: { ds: DataSource; storage: StoragePort }): JobHandler {
  return {
    type: 'media.audio',
    queue: 'media',
    async run({ job, signal, progress }) {
      const { source, original } = await loadSource(ds, job);
      const probe = source.probe as ProbeInfo | null;
      if (!probe) throw new FatalJobError('source has no probe result');
      const assets = ds.getRepository(MediaAssetEntity);
      const havePeaks = await assets.existsBy({
        sourceId: source.id,
        kind: 'peaks',
        recipeVersion: PEAKS_RECIPE,
      });
      const haveAudio =
        !probe.audio ||
        (await assets.existsBy({ sourceId: source.id, kind: 'audio', recipeVersion: AUDIO_RECIPE }));
      if (havePeaks && haveAudio) return { reused: true };

      const putPeaks = async (peaks: PeaksJson) => {
        const id = uuidv7();
        const key = storageKeys.derived(job.merchantId, source.id, id, 'peaks', PEAKS_RECIPE, 'json');
        const body = Buffer.from(JSON.stringify(peaks));
        const stored = await storage.put(key, body, { contentType: 'application/json' });
        const meta = {
          silent: peaks.silent,
          hasAudio: peaks.hasAudio,
          buckets: peaks.levels[0]?.max.length ?? 0,
        };
        if (
          !(await recordAsset(ds, {
            id,
            merchantId: job.merchantId,
            sourceId: source.id,
            kind: 'peaks',
            recipe: PEAKS_RECIPE,
            key,
            size: stored.size,
            sha256: stored.sha256,
            contentType: 'application/json',
            meta,
          }))
        ) {
          await storage.delete(key);
        }
        return meta;
      };

      if (!probe.audio) {
        const meta = await putPeaks(noAudioPeaks(probe.durationMs));
        return { ...meta, hasAudio: false };
      }

      const input = await storage.localPath(original.storageKey);
      try {
        return await withTempDir('audio', async (dir) => {
          const flac = join(dir, 'asr.flac');
          const peaks = new PeaksBuilder(PEAK_RATE);
          const expectedSamples = (probe.durationMs / 1000) * PEAK_RATE;
          let samples = 0;
          let lastReport = 0;
          await runProcess(
            'ffmpeg',
            [
              '-v',
              'error',
              '-y',
              '-nostdin',
              '-i',
              input.path,
              '-map',
              '0:a:0',
              '-vn',
              '-ac',
              '1',
              '-ar',
              '16000',
              '-c:a',
              'flac',
              flac,
              '-map',
              '0:a:0',
              '-vn',
              '-ac',
              '1',
              '-ar',
              String(PEAK_RATE),
              '-f',
              's16le',
              'pipe:1',
            ],
            {
              signal,
              onStdoutData: (chunk) => {
                peaks.pushBytes(chunk);
                samples += chunk.length / 2;
                const p = Math.min(0.95, samples / expectedSamples);
                if (p - lastReport > 0.02) {
                  lastReport = p;
                  void progress(p);
                }
              },
            },
          );
          const peaksMeta = havePeaks ? { reused: true } : await putPeaks(peaks.finish(probe.durationMs));
          let audioMeta: Record<string, unknown> = { reused: true };
          if (!haveAudio) {
            const id = uuidv7();
            const key = storageKeys.derived(job.merchantId, source.id, id, 'audio', AUDIO_RECIPE, 'flac');
            const stored = await storage.put(key, createReadStream(flac), { contentType: 'audio/flac' });
            audioMeta = { sampleRate: 16000, channels: 1, bytes: stored.size };
            if (
              !(await recordAsset(ds, {
                id,
                merchantId: job.merchantId,
                sourceId: source.id,
                kind: 'audio',
                recipe: AUDIO_RECIPE,
                key,
                size: stored.size,
                sha256: stored.sha256,
                contentType: 'audio/flac',
                meta: audioMeta,
              }))
            ) {
              await storage.delete(key);
            }
          }
          return { hasAudio: true, peaks: peaksMeta, audio: audioMeta, pcmSamples: samples };
        });
      } finally {
        await input.release();
      }
    },
    next: (job) => [
      {
        type: 'media.sprites',
        queue: 'media',
        payload: { sourceId: job.payload.sourceId },
        timeoutMs: 3600_000,
      },
    ],
    onDead: markSourceFailed,
  };
}
