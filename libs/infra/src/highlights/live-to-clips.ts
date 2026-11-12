import { readFile } from 'node:fs/promises';
import {
  finalizeClips,
  flattenTranscript,
  type LlmPort,
  pickTopCandidates,
  type SpanMs,
  type StoragePort,
  scoreWindows,
  type TimedSegment,
} from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import { AiServiceClient } from '../ai/ai-service.client.js';
import { AnalysisEntity, DetectedShotEntity } from '../db/entities/analysis.entity.js';
import { ClipSuggestionEntity } from '../db/entities/clip-suggestion.entity.js';
import { MediaAssetEntity } from '../db/entities/media-asset.entity.js';
import { ProjectEntity, ProjectVersionEntity } from '../db/entities/project.entity.js';
import { TranscriptEntity } from '../db/entities/transcript.entity.js';
import { FatalJobError, type JobHandler, type NextStep } from '../jobs/handlers.js';
import { assertRunCapacity, createRunInTransaction, enqueueInTransaction } from '../jobs/job-store.js';
import { loudnessFromPeaks, PEAKS_RECIPE, type PeaksJson } from '../media/peaks.js';
import type { ProbeInfo } from '../media/probe.js';
import { loadSource } from '../media/source-helpers.js';
import type { StageTextLayout } from '../render/text-layout.js';
import { correctCaptions, selectCaptionSegments } from './caption-fix.js';
import { layoutClipProject, seededIds } from './clip-project.js';
import { type ProductInfo, suggestHooks, suggestHooksRules } from './hooks.js';
import { flattenWords, limitByInputShare, rerankCandidates } from './rerank.js';

/**
 * The `live_to_clips` workflow (E07-F08, ARCHITECTURE §9): `shots.detect` → `clips.plan` → one `clips.build` per
 * clip. Plan = rule scoring over the corrected transcript (+ loudness), LLM re-ranking per LLM_MODE (skipped in
 * rules mode), boundary snapping to VAD silences / sentence ends / shot cuts. Build = hook + title, stage layout,
 * a new editable project (v1). Each finished build turns its card `ready`, so the review page fills up live.
 */
export const LIVE_TO_CLIPS_POOL = 12;
export const LIVE_TO_CLIPS_MAX_CLIPS = 8;

export class LiveToClipsUnavailableError extends Error {
  constructor(
    readonly reason: 'not_found' | 'not_ready' | 'no_transcript',
    message: string,
  ) {
    super(message);
    this.name = 'LiveToClipsUnavailableError';
  }
}

/** Starts a live-to-clips run for a source, or returns the unfinished one (unless `fresh` = regenerate). */
export async function requestLiveToClips(
  ds: DataSource,
  input: {
    merchantId: string;
    sourceId: string;
    product?: ProductInfo;
    fresh?: boolean;
    /** Edit style pack for the built clips (default pack when absent). */
    styleId?: string;
    maxUnfinishedRuns?: number;
  },
): Promise<{ runId: string; created: boolean }> {
  return ds.transaction(async (em) => {
    const rows: { status: string }[] = await em.query(
      `SELECT status FROM video_sources WHERE id = $1 AND merchant_id = $2 FOR UPDATE`,
      [input.sourceId, input.merchantId],
    );
    if (!rows[0]) throw new LiveToClipsUnavailableError('not_found', 'source not found');
    if (rows[0].status !== 'ready')
      throw new LiveToClipsUnavailableError('not_ready', 'source is still processing or failed');
    const t = await em
      .getRepository(TranscriptEntity)
      .existsBy({ merchantId: input.merchantId, sourceId: input.sourceId, status: 'ready' });
    if (!t) throw new LiveToClipsUnavailableError('no_transcript', 'source has no finished transcript');
    const open: { id: string }[] = await em.query(
      `SELECT id FROM workflow_runs WHERE merchant_id = $1 AND kind = 'live_to_clips' AND subject_type = 'source'
          AND subject_id = $2 AND status IN ('pending', 'running') ORDER BY created_at DESC LIMIT 1`,
      [input.merchantId, input.sourceId],
    );
    if (open[0]) return { runId: open[0].id, created: false };
    if (!input.fresh) {
      const done: { id: string }[] = await em.query(
        `SELECT id FROM workflow_runs WHERE merchant_id = $1 AND kind = 'live_to_clips' AND subject_type = 'source'
            AND subject_id = $2 AND status = 'succeeded' ORDER BY created_at DESC LIMIT 1`,
        [input.merchantId, input.sourceId],
      );
      if (done[0]) return { runId: done[0].id, created: false };
    }
    if (input.maxUnfinishedRuns) await assertRunCapacity(em, input.merchantId, input.maxUnfinishedRuns);
    const run = await createRunInTransaction(em, {
      merchantId: input.merchantId,
      kind: 'live_to_clips',
      subjectType: 'source',
      subjectId: input.sourceId,
      input: { product: input.product ?? {}, ...(input.styleId ? { styleId: input.styleId } : {}) },
    });
    await enqueueInTransaction(em, {
      merchantId: input.merchantId,
      workflowRunId: run.id,
      type: 'shots.detect',
      queue: 'ai',
      idempotencyKey: `${run.id}:shots.detect`,
      payload: {
        sourceId: input.sourceId,
        nextStep: 'clips.plan',
        product: input.product ?? {},
        ...(input.styleId ? { styleId: input.styleId } : {}),
      },
      timeoutMs: 60 * 60_000,
    });
    return { runId: run.id, created: true };
  });
}

/** Newest ready transcript of a source with the merchant's word corrections applied. */
export async function loadCorrectedTranscript(
  ds: DataSource,
  merchantId: string,
  sourceId: string,
): Promise<{ transcriptId: string; segments: TimedSegment[] }> {
  const t = await ds
    .getRepository(TranscriptEntity)
    .findOne({ where: { merchantId, sourceId, status: 'ready' }, order: { createdAt: 'DESC' } });
  if (!t) throw new FatalJobError('ยังไม่มีคำถอดเสียงของวิดีโอนี้ ถอดเสียงก่อนแล้วค่อยสร้างคลิป');
  const segs: {
    seq: number;
    start_ms: number;
    end_ms: number;
    text: string;
    words: TimedSegment['words'];
  }[] = await ds.query(
    `SELECT seq, start_ms, end_ms, text, words FROM transcript_segments WHERE transcript_id = $1 ORDER BY seq`,
    [t.id],
  );
  const edits: { seq: number; word_index: number; text: string }[] = await ds.query(
    `SELECT seq, word_index, text FROM transcript_edits WHERE transcript_id = $1`,
    [t.id],
  );
  const byKey = new Map(edits.map((e) => [`${e.seq}:${e.word_index}`, e.text]));
  return {
    transcriptId: t.id,
    segments: segs.map((s) => {
      const words = s.words.map((w, i) => ({ ...w, text: byKey.get(`${s.seq}:${i}`) ?? w.text }));
      const text = edits.some((e) => e.seq === s.seq) ? words.map((w) => w.text).join('') : s.text;
      return { startMs: s.start_ms, endMs: s.end_ms, text, words };
    }),
  };
}

export type LiveToClipsDeps = {
  ds: DataSource;
  storage: StoragePort;
  ai: AiServiceClient;
  llm: LlmPort;
  /** Opens a stage text layout (headless Chromium with the stage bundle). */
  openLayout: () => Promise<StageTextLayout>;
  maxClips?: number;
};

/** `speech`: VAD speech spans inside the clip (source ms) — the build step's jump cuts need the real pauses. */
const buildStep = (
  sourceId: string,
  rank: number,
  product: unknown,
  speech: SpanMs[],
  styleId: unknown,
): NextStep => ({
  type: 'clips.build',
  queue: 'ai',
  key: String(rank),
  payload: { sourceId, rank, product, speech, ...(typeof styleId === 'string' ? { styleId } : {}) },
  maxAttempts: 3,
  timeoutMs: 10 * 60_000,
});

export function clipsPlanHandler({ ds, storage, ai, llm, maxClips }: LiveToClipsDeps): JobHandler {
  return {
    type: 'clips.plan',
    queue: 'ai',
    async run({ job, signal, progress }) {
      const { source } = await loadSource(ds, job);
      const probe = source.probe as ProbeInfo | null;
      if (!probe) throw new FatalJobError('source has no probe result');
      const product = (job.payload.product ?? {}) as ProductInfo;
      const runId = job.workflowRunId;
      const existing = await ds
        .getRepository(ClipSuggestionEntity)
        .count({ where: { workflowRunId: runId } });
      if (existing > 0) return { clips: existing, ranks: await ranksOf(ds, runId), reused: true };

      const { segments } = await loadCorrectedTranscript(ds, job.merchantId, source.id);
      const assets = ds.getRepository(MediaAssetEntity);
      const audio = await assets.findOneBy({
        merchantId: job.merchantId,
        sourceId: source.id,
        kind: 'audio',
      });
      const peaksAsset = await assets.findOneBy({
        merchantId: job.merchantId,
        sourceId: source.id,
        kind: 'peaks',
        recipeVersion: PEAKS_RECIPE,
      });
      let speech: SpanMs[] = [];
      if (audio) {
        const f = await storage.localPath(audio.storageKey);
        try {
          const vad = await ai.vad(f.path, { signal });
          speech = vad.segments.map((s) => ({ startMs: s.start_ms, endMs: s.end_ms }));
        } finally {
          await f.release();
        }
      }
      let loudness: ReturnType<typeof loudnessFromPeaks> | undefined;
      if (peaksAsset) {
        const f = await storage.localPath(peaksAsset.storageKey);
        try {
          loudness = loudnessFromPeaks(JSON.parse(await readFile(f.path, 'utf8')) as PeaksJson);
        } finally {
          await f.release();
        }
      }
      const analysis = await ds
        .getRepository(AnalysisEntity)
        .findOneBy({ merchantId: job.merchantId, sourceId: source.id, kind: 'shots', status: 'ready' });
      const shotCutsMs = analysis
        ? (
            await ds
              .getRepository(DetectedShotEntity)
              .find({ where: { analysisId: analysis.id }, order: { seq: 'ASC' } })
          )
            .slice(1)
            .map((s) => s.startMs)
        : [];
      await progress(0.2);

      const windows = scoreWindows(
        { segments, loudness },
        { productTerms: product.name ? [product.name] : [] },
      );
      const pool = pickTopCandidates(windows, LIVE_TO_CLIPS_POOL);
      const words = flattenWords(segments);
      type Proposal = {
        id: string;
        startWord: number;
        endWord: number;
        score: number;
        type: string;
        reason: string;
        quote: string | null;
        origin: string;
      };
      let proposals: Proposal[];
      if (llm.mode === 'rules') {
        const top = Math.max(...pool.map((c) => c.score), 1);
        proposals = pool.map((c, i) => ({
          id: `c${i + 1}`,
          startWord: c.firstWord,
          endWord: c.lastWord,
          score: Math.round((100 * c.score) / top),
          type: 'other',
          reason: c.reason,
          quote: null,
          origin: 'rules',
        }));
      } else {
        const sent = limitByInputShare(pool, words);
        const r = await rerankCandidates(llm, segments, sent, {
          merchantId: job.merchantId,
          workflowRunId: runId,
        });
        proposals = r.clips
          .filter((c) => c.keep)
          .map((c) => ({
            id: c.candidateId,
            startWord: c.startWord,
            endWord: c.endWord,
            score: c.score,
            type: c.type,
            reason: c.reason,
            quote: c.quote,
            origin: 'llm',
          }));
      }
      await progress(0.8);
      const final = finalizeClips(
        proposals,
        { words: flattenTranscript(segments), speech, shotCutsMs, durationMs: probe.durationMs },
        { maxClips: maxClips ?? LIVE_TO_CLIPS_MAX_CLIPS },
      );
      if (final.length > 0) {
        await ds
          .createQueryBuilder()
          .insert()
          .into(ClipSuggestionEntity)
          .values(
            final.map((c) => ({
              merchantId: job.merchantId,
              sourceId: source.id,
              workflowRunId: runId,
              rank: c.rank,
              status: 'planned' as const,
              startMs: c.startMs,
              endMs: c.endMs,
              startWord: c.startWord,
              endWord: c.endWord,
              score: c.score,
              type: c.type,
              reason: c.reason,
              quote: c.quote,
              hook: null,
              title: source.title,
              origin: c.origin,
              mode: llm.mode,
            })),
          )
          .orIgnore()
          .execute();
      }
      const speechByRank: Record<string, SpanMs[]> = {};
      for (const c of final) {
        speechByRank[String(c.rank)] = speech
          .filter((s) => s.endMs > c.startMs && s.startMs < c.endMs)
          .map((s) => ({ startMs: s.startMs, endMs: s.endMs }));
      }
      return {
        clips: final.length,
        ranks: final.map((c) => c.rank),
        shotCuts: shotCutsMs.length,
        speechByRank,
      };
    },
    next(job, result) {
      const ranks = (result.ranks as number[]) ?? [];
      const speech = (result.speechByRank ?? {}) as Record<string, SpanMs[]>;
      return ranks.map((r) =>
        buildStep(
          String(job.payload.sourceId),
          r,
          job.payload.product ?? {},
          speech[String(r)] ?? [],
          job.payload.styleId,
        ),
      );
    },
  };
}

async function ranksOf(ds: DataSource, runId: string): Promise<number[]> {
  const rows = await ds
    .getRepository(ClipSuggestionEntity)
    .find({ where: { workflowRunId: runId }, order: { rank: 'ASC' } });
  return rows.map((r) => r.rank);
}

export function clipsBuildHandler({ ds, llm, openLayout }: LiveToClipsDeps): JobHandler {
  return {
    type: 'clips.build',
    queue: 'ai',
    async run({ job }) {
      const { source } = await loadSource(ds, job);
      const probe = source.probe as ProbeInfo | null;
      if (!probe) throw new FatalJobError('source has no probe result');
      const repo = ds.getRepository(ClipSuggestionEntity);
      const rank = Number(job.payload.rank);
      const s = await repo.findOneByOrFail({
        workflowRunId: job.workflowRunId,
        rank,
        merchantId: job.merchantId,
      });
      if (s.status === 'ready' || s.status === 'discarded') return { suggestionId: s.id, reused: true };
      const product = (job.payload.product ?? {}) as ProductInfo;

      const { segments } = await loadCorrectedTranscript(ds, job.merchantId, source.id);
      const words = flattenWords(segments);
      const firstSegment = words[s.startWord]?.segment ?? 0;
      const lastSegment = words[s.endWord]?.segment ?? firstSegment;
      const clip = { segments, firstSegment, lastSegment };
      let suggestions: Awaited<ReturnType<typeof suggestHooks>>;
      let hookFallback = false;
      try {
        suggestions = await suggestHooks(llm, clip, product, {
          merchantId: job.merchantId,
          workflowRunId: job.workflowRunId,
        });
      } catch {
        // a hook is optional: the clip still appears with the seller's own strongest sentence
        suggestions = suggestHooksRules(clip, product);
        hookFallback = true;
      }
      const hook = suggestions.find((x) => x.kind === 'hook');
      const title = suggestions.find((x) => x.kind === 'title')?.text ?? source.title;
      const clipWords = await correctCaptions(
        llm,
        selectCaptionSegments(segments, s.startWord, s.endWord),
        product.name ? [product.name] : [],
        { merchantId: job.merchantId, workflowRunId: job.workflowRunId },
      );
      const projectId = seededIds(`${job.workflowRunId}:${rank}:project`)();
      const layout = await openLayout();
      let project: Awaited<ReturnType<typeof layoutClipProject>>;
      try {
        project = await layoutClipProject(layout, {
          projectId,
          merchantId: job.merchantId,
          workflowRunId: job.workflowRunId,
          source: {
            sourceId: source.id,
            fps: probe.video.fps,
            durationFrames: probe.video.durationFrames,
            hasAudio: probe.audio !== null,
          },
          plan: {
            startMs: s.startMs,
            endMs: s.endMs,
            words: clipWords,
            title,
            hook: hook ? { text: hook.text, origin: hook.origin } : undefined,
          },
          seed: `${job.workflowRunId}:${rank}`,
          // older queued jobs have no speech spans: then only filler words are cut
          style: {
            ...(typeof job.payload.styleId === 'string' ? { styleId: job.payload.styleId } : {}),
            speech: Array.isArray(job.payload.speech) ? (job.payload.speech as SpanMs[]) : [],
          },
        });
      } finally {
        await layout.close();
      }
      await ds.transaction(async (em) => {
        const exists = await em.getRepository(ProjectEntity).existsBy({ id: projectId });
        if (!exists) {
          await em.getRepository(ProjectEntity).insert({
            id: projectId,
            merchantId: job.merchantId,
            title: title.slice(0, 200),
            currentVersion: 1,
          });
          await em.getRepository(ProjectVersionEntity).insert({
            merchantId: job.merchantId,
            projectId,
            version: 1,
            doc: project as never,
            reason: 'create',
            restoredFrom: null,
          });
        }
        await em
          .getRepository(ClipSuggestionEntity)
          .update(
            { id: s.id, status: 'planned' },
            { status: 'ready', projectId, hook: hook?.text ?? null, title: title.slice(0, 200), error: null },
          );
      });
      return { suggestionId: s.id, projectId, hookFallback };
    },
    async onDead(em, job, error) {
      await em.query(
        `UPDATE clip_suggestions SET status = 'failed', error = $4, updated_at = now()
          WHERE workflow_run_id = $1 AND rank = $2 AND merchant_id = $3 AND status = 'planned'`,
        [job.workflowRunId, Number(job.payload.rank), job.merchantId, error.message.slice(0, 1000)],
      );
    },
  };
}

export function liveToClipsHandlers(deps: LiveToClipsDeps): JobHandler[] {
  return [clipsPlanHandler(deps), clipsBuildHandler(deps)];
}
