import type { StoragePort } from '@myvideo/domain';
import type { DataSource, EntityManager } from 'typeorm';
import type { JobEntity } from '../db/entities/job.entity.js';
import { MediaAssetEntity } from '../db/entities/media-asset.entity.js';
import { VideoSourceEntity } from '../db/entities/video-source.entity.js';
import { FatalJobError, type JobHandler } from '../jobs/handlers.js';
import { type ProbeInfo, probeFile } from './probe.js';

export type IngestDeps = { ds: DataSource; storage: StoragePort };

const GENERIC_FAILURE = 'ประมวลผลวิดีโอไม่สำเร็จ ลองใหม่ได้ที่หน้า "งานประมวลผล"';

/** Marks the source failed with a merchant-readable reason (Thai). */
export async function markSourceFailed(
  em: EntityManager,
  job: JobEntity,
  error: { message: string; fatal: boolean },
) {
  const sourceId = String(job.payload.sourceId ?? '');
  if (!sourceId) return;
  await em.query(
    `UPDATE video_sources SET status = 'failed', failure_reason = $3, updated_at = now() WHERE id = $1 AND merchant_id = $2`,
    [sourceId, job.merchantId, error.fatal ? error.message : GENERIC_FAILURE],
  );
}

export async function loadSource(ds: DataSource, job: JobEntity) {
  const sourceId = String(job.payload.sourceId ?? '');
  const source = await ds
    .getRepository(VideoSourceEntity)
    .findOneBy({ id: sourceId, merchantId: job.merchantId });
  if (!source) throw new FatalJobError(`source ${sourceId} not found`);
  const original = await ds
    .getRepository(MediaAssetEntity)
    .findOneBy({ sourceId, merchantId: job.merchantId, kind: 'original' });
  if (!original) throw new FatalJobError(`source ${sourceId} has no original`);
  return { source, original };
}

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
  return [probeHandler(deps)];
}
