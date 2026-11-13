import { type FrozenStyle, stylePack } from '@myvideo/contracts';
import { withMusicTrack } from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import { MusicEntity } from '../db/entities/music.entity.js';
import { ProjectEntity, ProjectVersionEntity } from '../db/entities/project.entity.js';
import { type OutputRatio, seededIds } from '../highlights/clip-project.js';
import { FatalJobError, type JobHandler } from '../jobs/handlers.js';
import type { ProbeInfo } from '../media/probe.js';
import { buildVisualMontage, type VisualFootage } from './photo-project.js';

export async function visualFootage(
  ds: DataSource,
  merchantId: string,
  sourceIds: readonly string[],
): Promise<VisualFootage[]> {
  if (!sourceIds.length) return [];
  const rows = (await ds.query(
    `SELECT id,probe FROM video_sources WHERE merchant_id=$1 AND id=ANY($2::uuid[]) AND status='ready'`,
    [merchantId, sourceIds],
  )) as { id: string; probe: ProbeInfo }[];
  return sourceIds.flatMap((id) => {
    const r = rows.find((r) => r.id === id);
    return r
      ? [
          {
            sourceId: r.id,
            kind: r.probe.still ? ('image' as const) : ('video' as const),
            width: r.probe.video.width,
            height: r.probe.video.height,
            durationFrames: Math.max(1, Math.round((r.probe.durationMs * 30) / 1000)),
          },
        ]
      : [];
  });
}
export function visualMontageHandler({ ds }: { ds: DataSource }): JobHandler {
  return {
    type: 'folder.montage',
    queue: 'ai',
    async run({ job, signal }) {
      const ids = job.payload.sourceIds as string[];
      const styleId = typeof job.payload.styleId === 'string' ? job.payload.styleId : undefined;
      const projectId = seededIds(`${job.workflowRunId}:montage:${styleId ?? 'plain'}`)();
      if (await ds.getRepository(ProjectEntity).existsBy({ id: projectId, merchantId: job.merchantId }))
        return { projectId, reused: true };
      const sources = await visualFootage(ds, job.merchantId, ids);
      if (sources.length !== ids.length) throw new FatalJobError('ฟุตเทจบางไฟล์ถูกลบหรือยังไม่พร้อม');
      let project = buildVisualMontage({
        projectId,
        merchantId: job.merchantId,
        seed: `${job.workflowRunId}:montage`,
        workflowRunId: job.workflowRunId,
        ratio: job.payload.ratio as OutputRatio,
        sources,
        ...(styleId
          ? { style: (job.payload.frozenStyle as FrozenStyle | undefined)?.pack ?? stylePack(styleId) }
          : {}),
        ...(typeof job.payload.seconds === 'number' ? { seconds: job.payload.seconds } : {}),
      });
      if (typeof job.payload.musicId === 'string') {
        const music = await ds.getRepository(MusicEntity).findOneBy({
          id: job.payload.musicId,
          merchantId: job.merchantId,
          status: 'ready',
        });
        if (!music?.durationMs || !music.analysis) throw new FatalJobError('เพลงที่เลือกยังไม่พร้อม');
        project = withMusicTrack(
          project,
          {
            musicId: music.id,
            durationMs: music.durationMs,
            analysis: music.analysis as {
              bpm: number | null;
              firstBeatSec: number | null;
              beatsSec: number[];
              dropsSec: number[];
            },
          },
          seededIds(`${job.workflowRunId}:montage-music:${styleId}`),
        );
      }
      signal.throwIfAborted();
      await ds.transaction(async (em) => {
        await em
          .getRepository(ProjectEntity)
          .insert({ id: projectId, merchantId: job.merchantId, title: 'ภาพสินค้า', currentVersion: 1 });
        await em.getRepository(ProjectVersionEntity).insert({
          merchantId: job.merchantId,
          projectId,
          version: 1,
          doc: project as never,
          reason: 'create',
          restoredFrom: null,
        });
      });
      return { projectId };
    },
    next() {
      return [{ type: 'folder.advance', queue: 'ai', key: 'montage-complete', payload: {} }];
    },
  };
}
