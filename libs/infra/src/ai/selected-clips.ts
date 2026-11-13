import { join } from 'node:path';
import { type StoragePort, uuidv7 } from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import { MediaAssetEntity } from '../db/entities/media-asset.entity.js';
import { ProjectEntity, ProjectVersionEntity } from '../db/entities/project.entity.js';
import { type ClipWordMs, layoutClipProject } from '../highlights/clip-project.js';
import { sourceInfo } from '../highlights/live-to-clips.js';
import { FatalJobError, type JobHandler } from '../jobs/handlers.js';
import { assertRunCapacity, createRunInTransaction, enqueueInTransaction } from '../jobs/job-store.js';
import type { ProbeInfo } from '../media/probe.js';
import { loadSource } from '../media/source-helpers.js';
import { runProcess, withTempDir } from '../process/run-process.js';
import type { StageTextLayout } from '../render/text-layout.js';
import type { AiServiceClient } from './ai-service.client.js';
import { asrWhenFree, chunkCutArgs } from './transcribe-handlers.js';

export type SelectedRange = { startMs: number; endMs: number };
export class SelectedClipsError extends Error {
  constructor(
    readonly reason: 'not_found' | 'not_ready' | 'invalid_range',
    message: string,
  ) {
    super(message);
  }
}

/** Selection boundaries are explicit: never merge ranges or expand them into unselected audio. */
export function validateSelectedRanges(
  ranges: readonly SelectedRange[],
  durationMs: number,
): SelectedRange[] {
  if (!ranges.length || ranges.length > 20)
    throw new SelectedClipsError('invalid_range', 'เลือกตั้งแต่ 1 ถึง 20 ช่วง');
  const sorted = ranges.map((r) => ({ ...r })).sort((a, b) => a.startMs - b.startMs);
  for (const [i, r] of sorted.entries()) {
    if (
      !Number.isSafeInteger(r.startMs) ||
      !Number.isSafeInteger(r.endMs) ||
      r.startMs < 0 ||
      r.endMs <= r.startMs ||
      r.endMs > durationMs ||
      r.endMs - r.startMs > 600000 ||
      (i > 0 && r.startMs < (sorted[i - 1]?.endMs ?? 0))
    )
      throw new SelectedClipsError('invalid_range', 'ช่วงเวลาต้องไม่ทับกัน อยู่ภายในวิดีโอ และยาวช่วงละไม่เกิน 10 นาที');
  }
  return sorted;
}

export function selectedClipWords(
  segments: readonly { words: readonly { text: string; start_ms: number; end_ms: number }[] }[],
  range: SelectedRange,
): ClipWordMs[] {
  return segments
    .flatMap((s) => s.words)
    .map((w) => ({
      text: w.text,
      startMs: Math.max(range.startMs, w.start_ms + range.startMs),
      endMs: Math.min(range.endMs, w.end_ms + range.startMs),
    }))
    .filter((w) => w.text.trim() && w.endMs > w.startMs);
}

/** Same durable outbox as full transcription, with a separate mode: no full-source transcript is created. */
export async function requestSelectedClips(
  ds: DataSource,
  input: {
    merchantId: string;
    sourceId: string;
    ranges: SelectedRange[];
    requestId: string;
    maxUnfinishedRuns?: number;
  },
) {
  return ds.transaction(async (em) => {
    const [source] = (await em.query(
      `SELECT status, probe FROM video_sources WHERE id = $1 AND merchant_id = $2 FOR UPDATE`,
      [input.sourceId, input.merchantId],
    )) as { status: string; probe: ProbeInfo | null }[];
    if (!source) throw new SelectedClipsError('not_found', 'ไม่พบวิดีโอนี้');
    if (source.status !== 'ready' || !source.probe?.audio)
      throw new SelectedClipsError('not_ready', 'รอให้วิดีโอพร้อมและมีเสียงก่อนเลือกถอดเสียง');
    const ranges = validateSelectedRanges(input.ranges, source.probe.durationMs);
    const [existing] = (await em.query(
      `SELECT id FROM workflow_runs WHERE merchant_id = $1 AND kind = 'transcribe' AND subject_id = $2 AND input->>'mode' = 'selected-clips' AND input->>'requestId' = $3`,
      [input.merchantId, input.sourceId, input.requestId],
    )) as { id: string }[];
    if (existing) return existing.id;
    if (input.maxUnfinishedRuns) await assertRunCapacity(em, input.merchantId, input.maxUnfinishedRuns);
    const clips = ranges.map((r) => ({ ...r, projectId: uuidv7() }));
    const run = await createRunInTransaction(em, {
      merchantId: input.merchantId,
      kind: 'transcribe',
      subjectType: 'source',
      subjectId: input.sourceId,
      input: { mode: 'selected-clips', requestId: input.requestId, clips },
    });
    for (const [i, clip] of clips.entries())
      await enqueueInTransaction(em, {
        merchantId: input.merchantId,
        workflowRunId: run.id,
        type: 'asr.selected-clip',
        queue: 'ai',
        idempotencyKey: `${run.id}:selected:${i}`,
        payload: { sourceId: input.sourceId, ...clip },
        timeoutMs: 30 * 60000,
      });
    return run.id;
  });
}

export function selectedClipsHandler({
  ds,
  storage,
  ai,
  openLayout,
}: {
  ds: DataSource;
  storage: StoragePort;
  ai: AiServiceClient;
  openLayout: () => Promise<StageTextLayout>;
}): JobHandler {
  return {
    type: 'asr.selected-clip',
    queue: 'ai',
    async run({ job, signal, progress }) {
      const projectId = String(job.payload.projectId);
      if (await ds.getRepository(ProjectEntity).existsBy({ id: projectId, merchantId: job.merchantId }))
        return { projectId, reused: true };
      const { source } = await loadSource(ds, job);
      const probe = source.probe as ProbeInfo;
      const range = validateSelectedRanges(
        [{ startMs: Number(job.payload.startMs), endMs: Number(job.payload.endMs) }],
        probe.durationMs,
      )[0] as SelectedRange;
      const audio = await ds
        .getRepository(MediaAssetEntity)
        .findOneBy({ merchantId: job.merchantId, sourceId: source.id, kind: 'audio' });
      if (!audio) throw new FatalJobError('ไม่พบเสียงของวิดีโอนี้');
      const file = await storage.localPath(audio.storageKey);
      let words: ClipWordMs[];
      try {
        words = await withTempDir('selected-asr', async (dir) => {
          const wav = join(dir, 'selected.wav');
          await runProcess('ffmpeg', chunkCutArgs(file.path, { index: 0, ...range }, wav), { signal });
          await progress(0.05);
          const result = await asrWhenFree(ai, wav, signal, 5000, 20 * 60000);
          return selectedClipWords(result.segments, range);
        });
      } finally {
        await file.release();
      }
      await progress(0.8);
      signal.throwIfAborted();
      const title =
        `${source.title} · ${Math.floor(range.startMs / 1000)}–${Math.ceil(range.endMs / 1000)} วินาที`.slice(
          0,
          200,
        );
      const layout = await openLayout();
      let project: Awaited<ReturnType<typeof layoutClipProject>>;
      try {
        project = await layoutClipProject(layout, {
          projectId,
          merchantId: job.merchantId,
          workflowRunId: job.workflowRunId,
          source: sourceInfo(source.id, probe),
          plan: { ...range, words, title },
          seed: projectId,
        });
      } finally {
        await layout.close();
      }
      project.meta.createdBy = 'user';
      for (const element of Object.values(project.elements)) element.origin = 'user';
      signal.throwIfAborted();
      await ds.transaction(async (em) => {
        // Serialize retries with cancellation/deletion of the source; never resurrect a deleted input.
        const owned = await em.query(
          `SELECT id FROM video_sources WHERE id = $1 AND merchant_id = $2 FOR KEY SHARE`,
          [source.id, job.merchantId],
        );
        if (!owned.length) throw new FatalJobError('วิดีโอต้นฉบับถูกลบแล้ว');
        await em
          .getRepository(ProjectEntity)
          .insert({ id: projectId, merchantId: job.merchantId, title, currentVersion: 1 });
        await em.getRepository(ProjectVersionEntity).insert({
          merchantId: job.merchantId,
          projectId,
          version: 1,
          doc: project as never,
          reason: 'create',
          restoredFrom: null,
        });
      });
      return { projectId, words: words.length };
    },
  };
}
