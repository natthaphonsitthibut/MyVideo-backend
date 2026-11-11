import type { DataSource, EntityManager } from 'typeorm';
import type { JobEntity } from '../db/entities/job.entity.js';
import { MediaAssetEntity } from '../db/entities/media-asset.entity.js';
import { VideoSourceEntity } from '../db/entities/video-source.entity.js';
import { FatalJobError } from '../jobs/handlers.js';

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
