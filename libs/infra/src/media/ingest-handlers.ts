import type { StoragePort } from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import { FatalJobError, type JobHandler } from '../jobs/handlers.js';
import { audioHandler } from './audio-handler.js';
import { type ProbeInfo, probeFile } from './probe.js';
import { proxyHandler } from './proxy-handler.js';
import { loadSource, markSourceFailed } from './source-helpers.js';
import { spritesHandler } from './sprites-handler.js';

export { loadSource, markSourceFailed };

export type IngestDeps = {
  ds: DataSource;
  storage: StoragePort;
  proxyEncoder?: 'libx264' | 'h264_videotoolbox';
  proxySegmentSeconds?: number;
};

/** Step 1 of ingest: ffprobe the immutable original and validate it (fatal rejections never retry). */
export function probeHandler({ ds, storage }: IngestDeps): JobHandler {
  return {
    type: 'media.probe',
    queue: 'media',
    async run({ job, signal, progress }) {
      const { source, original } = await loadSource(ds, job);
      const file = await storage.localPath(original.storageKey);
      try {
        const outcome = await probeFile(file.path, { signal });
        if (!outcome.ok) throw new FatalJobError(outcome.messageTh);
        const info: ProbeInfo = { ...outcome.info, sizeBytes: Number(source.sizeBytes) };
        await ds.query(
          `UPDATE video_sources SET probe = $3, updated_at = now() WHERE id = $1 AND merchant_id = $2`,
          [source.id, job.merchantId, JSON.stringify(info)],
        );
        await progress(1);
        const { video, audio, durationMs } = info;
        return {
          durationMs,
          width: video.width,
          height: video.height,
          fps: video.fps,
          vfr: video.vfr,
          hasAudio: !!audio,
        };
      } finally {
        await file.release();
      }
    },
    next: (job) => [
      {
        type: 'media.proxy',
        queue: 'media',
        payload: { sourceId: job.payload.sourceId },
        timeoutMs: 4 * 3600_000,
      },
    ],
    onDead: markSourceFailed,
  };
}

export function ingestHandlers(deps: IngestDeps): JobHandler[] {
  return [
    probeHandler(deps),
    proxyHandler({
      ...deps,
      encoder: deps.proxyEncoder ?? 'libx264',
      segmentSeconds: deps.proxySegmentSeconds ?? 300,
    }),
    audioHandler(deps),
    spritesHandler(deps),
  ];
}
