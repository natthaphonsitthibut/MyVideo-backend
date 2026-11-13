import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type FrozenStyle, STYLE_PACKS } from '@myvideo/contracts';
import {
  finalizeClips,
  flattenTranscript,
  type LlmPort,
  pickTopCandidates,
  type SpanMs,
  type StoragePort,
  scoreWindows,
  type TimedSegment,
  withMusicTrack,
} from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import { AiServiceClient } from '../ai/ai-service.client.js';
import { AnalysisEntity, DetectedShotEntity } from '../db/entities/analysis.entity.js';
import { ClipSuggestionEntity } from '../db/entities/clip-suggestion.entity.js';
import { MediaAssetEntity } from '../db/entities/media-asset.entity.js';
import { MusicEntity } from '../db/entities/music.entity.js';
import { ProjectEntity, ProjectVersionEntity } from '../db/entities/project.entity.js';
import { TranscriptEntity } from '../db/entities/transcript.entity.js';
import { addPhotoCutaways } from '../folders/photo-project.js';
import { FatalJobError, type JobHandler, type NextStep } from '../jobs/handlers.js';
import { assertRunCapacity, createRunInTransaction, enqueueInTransaction } from '../jobs/job-store.js';
import { loudnessFromPeaks, PEAKS_RECIPE, type PeaksJson } from '../media/peaks.js';
import type { ProbeInfo } from '../media/probe.js';
import { loadSource } from '../media/source-helpers.js';
import { runProcess, withTempDir } from '../process/run-process.js';
import type { StageTextLayout } from '../render/text-layout.js';
import { clipCaptionWords, selectCaptionSegments } from './caption-fix.js';
import { type ClipBuildInput, clipBuildInput, planOf } from './clip-build-input.js';
import { clipEndWithTail, normalizeThaiSpelling } from './clip-ending.js';
import { layoutClipProject, OUTPUT_FRAMES, type OutputRatio, seededIds } from './clip-project.js';
import { type ProductInfo, suggestHooks, suggestHooksRules } from './hooks.js';
import { keyMomentKind } from './jump-cuts.js';
import { flattenWords, limitByInputShare, rerankCandidates } from './rerank.js';
import { adviseStyles, type StyleAdvice } from './style-advice.js';
import { inspectMoments } from './targeted-vision.js';

/**
 * The `live_to_clips` workflow (E07-F08, ARCHITECTURE §9): `shots.detect` → `clips.plan` → one `clips.build` per
 * clip. Plan = rule scoring over the corrected transcript (+ loudness), LLM re-ranking per LLM_MODE (skipped in
 * rules mode), boundary snapping to VAD silences / sentence ends / shot cuts. Build = hook + title, stage layout,
 * a new editable project (v1). Each finished build turns its card `ready`, so the review page fills up live.
 */
/**
 * Pauses the jump cuts can use (E13-F02). Measured 2026-11-13 on the real live clip C02 (55 s): the default
 * 300 ms / 100 ms pad saw 9 pauses and one 21.2 s block of speech; 150 ms / 40 ms pad saw 14 pauses, longest block
 * 6.9 s (120/30 found no more). A live seller's phrase breaks are ~0.25–0.5 s, the old setting merged them.
 */
export const CLIP_VAD = { minSilenceMs: 150, speechPadMs: 40 } as const;
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
    const rows: { status: string; probe: ProbeInfo | null }[] = await em.query(
      `SELECT status,probe FROM video_sources WHERE id = $1 AND merchant_id = $2 FOR UPDATE`,
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
    const transcriptFirst = (rows[0].probe?.durationMs ?? 0) > 180000;
    await enqueueInTransaction(em, {
      merchantId: input.merchantId,
      workflowRunId: run.id,
      type: transcriptFirst ? 'clips.plan' : 'shots.detect',
      queue: 'ai',
      idempotencyKey: `${run.id}:${transcriptFirst ? 'clips.plan' : 'shots.detect'}`,
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

export class BuildClipsUnavailableError extends Error {
  constructor(
    readonly reason: 'not_found' | 'unknown_style' | 'not_analysed',
    message: string,
  ) {
    super(message);
    this.name = 'BuildClipsUnavailableError';
  }
}

/**
 * The merchant picked a style for the newest analysis run of a source: edit its planned clips with that style in a
 * `build_clips` run (one `clips.build` per clip; the clips stay owned by the analysis run). Joins an unfinished
 * build of the same analysis instead of starting a second one.
 */
export async function requestBuildClips(
  ds: DataSource,
  input: {
    merchantId: string;
    sourceId: string;
    styleId: string;
    styleIds?: string[];
    /** Output frame of the edited clips (default 9:16). */
    ratio?: OutputRatio;
    photos?: ClipBuildInput['photos'];
    frozenStyle?: FrozenStyle;
    musicId?: string;
    maxUnfinishedRuns?: number;
  },
): Promise<{ runId: string; created: boolean }> {
  const styles = [...new Set([input.styleId, ...(input.styleIds ?? [])])];
  if (
    styles.length > 3 ||
    styles.some((id) => !STYLE_PACKS.some((p) => p.id === id) && input.frozenStyle?.pack.id !== id)
  )
    throw new BuildClipsUnavailableError('unknown_style', 'unknown style');
  return ds.transaction(async (em) => {
    const src: unknown[] = await em.query(
      `SELECT 1 FROM video_sources WHERE id = $1 AND merchant_id = $2 FOR UPDATE`,
      [input.sourceId, input.merchantId],
    );
    if (src.length === 0) throw new BuildClipsUnavailableError('not_found', 'source not found');
    const plans: { id: string; input: { product?: ProductInfo } }[] = await em.query(
      `SELECT id, input FROM workflow_runs WHERE merchant_id = $1 AND kind = 'live_to_clips' AND subject_type = 'source'
          AND subject_id = $2 AND status = 'succeeded' ORDER BY created_at DESC LIMIT 1`,
      [input.merchantId, input.sourceId],
    );
    const plan = plans[0];
    if (!plan) throw new BuildClipsUnavailableError('not_analysed', 'no finished analysis');
    const open: { id: string }[] = await em.query(
      `SELECT id FROM workflow_runs WHERE merchant_id = $1 AND kind = 'build_clips' AND input->>'planRunId' = $2
          AND status IN ('pending', 'running') LIMIT 1`,
      [input.merchantId, plan.id],
    );
    if (open[0]) return { runId: open[0].id, created: false };
    const planned = await em.getRepository(ClipSuggestionEntity).find({
      where: { merchantId: input.merchantId, workflowRunId: plan.id, status: 'planned' },
      order: { rank: 'ASC' },
    });
    if (planned.length === 0) throw new BuildClipsUnavailableError('not_analysed', 'nothing left to edit');
    const planJob: { result: { speechByRank?: Record<string, SpanMs[]> } | null }[] = await em.query(
      `SELECT result FROM jobs WHERE workflow_run_id = $1 AND type = 'clips.plan' AND status = 'succeeded' LIMIT 1`,
      [plan.id],
    );
    const speech = planJob[0]?.result?.speechByRank ?? {};
    let music: ClipBuildInput['music'];
    if (input.musicId) {
      const row = await em
        .getRepository(MusicEntity)
        .findOneBy({ id: input.musicId, merchantId: input.merchantId, status: 'ready' });
      if (!row?.durationMs || !row.analysis)
        throw new BuildClipsUnavailableError('not_found', 'เพลงที่เลือกยังไม่พร้อม');
      music = {
        musicId: row.id,
        durationMs: row.durationMs,
        analysis: row.analysis as NonNullable<ClipBuildInput['music']>['analysis'],
      };
    }
    if (input.maxUnfinishedRuns) await assertRunCapacity(em, input.merchantId, input.maxUnfinishedRuns);
    const run = await createRunInTransaction(em, {
      merchantId: input.merchantId,
      kind: 'build_clips',
      subjectType: 'source',
      subjectId: input.sourceId,
      input: {
        planRunId: plan.id,
        styleId: input.styleId,
        styleIds: styles,
        ...(input.ratio ? { ratio: input.ratio } : {}),
      },
    });
    for (const s of planned) {
      const variants: { styleId: string; rank: number }[] = [];
      for (const [i, styleId] of styles.slice(1).entries()) {
        const rank = Math.max(...planned.map((s) => s.rank)) * (i + 1) + s.rank;
        const {
          id: _id,
          createdAt: _created,
          updatedAt: _updated,
          merchant: _merchant,
          source: _source,
          workflowRun: _run,
          project: _project,
          buildInput: _buildInput,
          ...copy
        } = s;
        await em.getRepository(ClipSuggestionEntity).insert({ ...copy, rank });
        variants.push({ styleId, rank });
      }
      await enqueueInTransaction(em, {
        merchantId: input.merchantId,
        workflowRunId: run.id,
        type: 'clips.build',
        queue: 'ai',
        idempotencyKey: `${run.id}:clips.build:${s.rank}`,
        payload: {
          sourceId: input.sourceId,
          rank: s.rank,
          planRunId: plan.id,
          product: plan.input?.product ?? {},
          speech: speech[String(s.rank)] ?? [],
          styleId: input.styleId,
          ...(music ? { music } : {}),
          ...(variants.length ? { variants } : {}),
          ...(input.photos?.length ? { photos: input.photos } : {}),
          ...(input.frozenStyle ? { frozenStyle: input.frozenStyle } : {}),
          ...(input.ratio ? { ratio: input.ratio } : {}),
        },
        maxAttempts: 3,
        timeoutMs: 10 * 60_000,
      });
    }
    return { runId: run.id, created: true };
  });
}

/** Newest ready transcript of a source with the merchant's word corrections applied. */
export async function loadCorrectedTranscript(
  ds: DataSource,
  merchantId: string,
  sourceId: string,
): Promise<{ transcriptId: string; segments: TimedSegment[]; aiFixed: boolean }> {
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
    `SELECT seq, start_ms, end_ms, text, words FROM transcript_segments WHERE transcript_id = $1 AND merchant_id = $2 ORDER BY seq`,
    [t.id, merchantId],
  );
  const edits: { seq: number; word_index: number; text: string; origin: 'user' | 'ai' }[] = await ds.query(
    `SELECT seq, word_index, text, origin FROM transcript_edits WHERE transcript_id = $1 AND merchant_id = $2`,
    [t.id, merchantId],
  );
  const byKey = new Map(edits.map((e) => [`${e.seq}:${e.word_index}`, e]));
  return {
    transcriptId: t.id,
    aiFixed: t.aiFixCompleted || edits.some((e) => e.origin === 'ai'),
    segments: segs.map((s) => {
      type Word = TimedSegment['words'][number] & { origin?: 'ai'; asrText?: string };
      const words: Word[] = [];
      s.words.forEach((w, i) => {
        const edit = byKey.get(`${s.seq}:${i}`);
        const prev = words[words.length - 1];
        // an empty AI edit continues the glossary term on the word before: one word over both audio spans
        if (edit?.origin === 'ai' && edit.text === '' && prev) {
          prev.endMs = w.endMs;
          prev.asrText = `${prev.asrText ?? prev.text} ${w.text}`;
          return;
        }
        if (!edit) words.push(w);
        // only AI corrections carry the undo mark; the merchant's own fix is plain text
        else if (edit.origin === 'ai')
          words.push({ ...w, text: edit.text, origin: 'ai' as const, asrText: w.text });
        else words.push({ ...w, text: edit.text });
      });
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
      const { source, original } = await loadSource(ds, job);
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
          const vad = await ai.vad(f.path, { ...CLIP_VAD, signal });
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
      const vision =
        probe.durationMs > 180000
          ? await inspectMoments({
              storage,
              originalKey: original.storageKey,
              sourceId: source.id,
              contentHash: source.sha256,
              durationMs: probe.durationMs,
              candidates: pool.map((c, i) => ({
                id: `c${i + 1}`,
                startMs: words[c.firstWord]?.startMs ?? 0,
                endMs: words[c.lastWord]?.endMs ?? probe.durationMs,
                score: c.score,
              })),
              llm,
              context: { merchantId: job.merchantId, workflowRunId: runId, signal },
            })
          : { frames: 0, sheets: 0, tags: [], calls: 0 };
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
      for (const p of proposals) {
        const t = vision.tags.find((t) => t.candidateId === p.id);
        if (t && t.confidence >= 0.7)
          p.score = Math.min(100, p.score + (t.productInHand ? 3 : 0) + (t.closeUp ? 2 : 0));
      }
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
      // no style chosen yet: recommend styles for this video; the merchant picks one, then `build_clips` edits
      let advice: StyleAdvice | undefined;
      if (typeof job.payload.styleId !== 'string' && final.length > 0) {
        const flat = flattenTranscript(segments);
        const speechSec =
          speech.reduce((n, s) => n + (s.endMs - s.startMs), 0) / 1000 || probe.durationMs / 1000;
        const minutes = Math.max(probe.durationMs / 60_000, 1 / 60);
        const texts = flat.map((w) => w.text);
        let prices = 0;
        let ctas = 0;
        for (let i = 0; i < texts.length; i++) {
          const kind = keyMomentKind(texts.slice(i, i + 2));
          if (kind === 'price' && !/^\d/.test(texts[i - 1] ?? '')) prices++;
          if (kind === 'cta') ctas++;
        }
        const pauses = speech.filter(
          (s, i) => i > 0 && s.startMs - (speech[i - 1] as SpanMs).endMs >= 500,
        ).length;
        const sample = final
          .map((c) => texts.slice(c.startWord, c.endWord + 1).join(''))
          .join(' … ')
          .slice(0, 2500);
        advice = await adviseStyles(
          llm,
          {
            durationMin: Math.round(minutes * 10) / 10,
            wordsPerSec: Math.round((texts.length / speechSec) * 10) / 10,
            pricesPerMin: Math.round((prices / minutes) * 10) / 10,
            ctaPerMin: Math.round((ctas / minutes) * 10) / 10,
            pausesPerMin: Math.round((pauses / minutes) * 10) / 10,
            productTerms: product.name ? [product.name] : [],
          },
          sample,
          { merchantId: job.merchantId, workflowRunId: runId },
        );
      }
      return {
        clips: final.length,
        ranks: final.map((c) => c.rank),
        shotCuts: shotCutsMs.length,
        vision,
        speechByRank,
        ...(advice ? { advice } : {}),
      };
    },
    next(job, result) {
      // analysis only: the edit starts when the merchant picks a style (`requestBuildClips`)
      if (typeof job.payload.styleId !== 'string') return [];
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

/** The project id of the clip at `rank` of a run — the same on rebuilds and restyles. */
export function clipProjectId(workflowRunId: string, rank: number): string {
  return seededIds(`${workflowRunId}:${rank}:project`)();
}

export function sourceInfo(sourceId: string, probe: ProbeInfo) {
  return {
    sourceId,
    fps: probe.video.fps,
    durationFrames: probe.video.durationFrames,
    hasAudio: probe.audio !== null,
    width: probe.video.width,
    height: probe.video.height,
  };
}

/**
 * Stage layout + pure builder from a stored build input (no AI): used by the build and by restyles. The seed is the
 * run + rank, so the same input and style give the same project (element ids included).
 */
export async function layoutClip(
  openLayout: () => Promise<StageTextLayout>,
  a: {
    projectId: string;
    merchantId: string;
    workflowRunId: string;
    rank: number;
    source: ReturnType<typeof sourceInfo>;
    input: ClipBuildInput;
    styleId: string | undefined;
  },
) {
  const layout = await openLayout();
  try {
    const frozen = a.input.frozenStyle?.pack.id === a.styleId ? a.input.frozenStyle : undefined;
    const seed = frozen
      ? createHash('sha256')
          .update(JSON.stringify([frozen.seed, a.source, a.input]))
          .digest('hex')
      : `${a.workflowRunId}:${a.rank}`;
    const project = await layoutClipProject(layout, {
      projectId: frozen ? seededIds(`${seed}:project`)() : a.projectId,
      merchantId: a.merchantId,
      ...(!frozen ? { workflowRunId: a.workflowRunId } : {}),
      source: a.source,
      plan: planOf(a.input),
      seed,
      style: {
        ...(a.styleId ? { styleId: a.styleId } : {}),
        speech: a.input.speech,
        ...(frozen ? { resolved: frozen.pack } : {}),
      },
      ...(a.input.productName ? { productName: a.input.productName } : {}),
      ...(a.input.ratio ? { ratio: a.input.ratio } : {}),
      ...(a.input.faceX !== undefined ? { faceX: a.input.faceX } : {}),
    });
    const composition = addPhotoCutaways(project, a.input.photos ?? [], seed);
    return a.input.music
      ? withMusicTrack(composition, a.input.music, seededIds(`${seed}:music`))
      : composition;
  } finally {
    await layout.close();
  }
}

/**
 * Where the face is across a clip, for crops that cut the sides (16:9 footage in a 9:16 frame): the largest face on
 * 3 frames (10 %, 50 %, 90 % of the clip), median centre as a share of the width. Undefined when no face is seen or
 * the measurement fails — the crop then stays centred (a re-frame is a nicety, never a reason to fail the clip).
 */
export async function measureFaceX(
  ai: AiServiceClient,
  storage: StoragePort,
  originalKey: string,
  startMs: number,
  endMs: number,
): Promise<number | undefined> {
  try {
    const file = await storage.localPath(originalKey);
    try {
      return await withTempDir('faces', async (dir) => {
        const paths: string[] = [];
        for (const [i, share] of [0.1, 0.5, 0.9].entries()) {
          const out = join(dir, `face-${i}.jpg`);
          const t = (startMs + (endMs - startMs) * share) / 1000;
          await runProcess('ffmpeg', [
            '-v',
            'error',
            '-y',
            '-nostdin',
            '-ss',
            t.toFixed(3),
            '-i',
            file.path,
            '-frames:v',
            '1',
            '-vf',
            'scale=-2:540',
            out,
          ]);
          paths.push(out);
        }
        const res = await ai.faces(paths);
        const xs = res.images
          .map((img) => img.center_x)
          .filter((x): x is number => typeof x === 'number')
          .sort((a, b) => a - b);
        return xs.length ? (xs[Math.floor(xs.length / 2)] as number) : undefined;
      });
    } finally {
      await file.release();
    }
  } catch {
    return undefined;
  }
}

export function clipsBuildHandler({ ds, storage, ai, llm, openLayout }: LiveToClipsDeps): JobHandler {
  return {
    type: 'clips.build',
    queue: 'ai',
    async run({ job }) {
      const { source, original } = await loadSource(ds, job);
      const probe = source.probe as ProbeInfo | null;
      if (!probe) throw new FatalJobError('source has no probe result');
      const repo = ds.getRepository(ClipSuggestionEntity);
      const rank = Number(job.payload.rank);
      // a build started by the merchant's style choice runs in its own run; the clips belong to the analysis run
      const planRunId = typeof job.payload.planRunId === 'string' ? job.payload.planRunId : job.workflowRunId;
      const s = await repo.findOneByOrFail({
        workflowRunId: planRunId,
        rank,
        merchantId: job.merchantId,
      });
      if (s.status === 'ready' || s.status === 'discarded') return { suggestionId: s.id, reused: true };
      // A second style reuses the completed first draft's words/hooks; editing never calls AI again.
      if (typeof job.payload.baseRank === 'number') {
        const base = await repo.findOneByOrFail({
          workflowRunId: planRunId,
          rank: job.payload.baseRank,
          merchantId: job.merchantId,
        });
        if (!base.buildInput) throw new FatalJobError('ยังไม่มีข้อมูลคลิปต้นแบบสำหรับสไตล์นี้');
        const project = await layoutClip(openLayout, {
          projectId: clipProjectId(planRunId, rank),
          merchantId: job.merchantId,
          workflowRunId: planRunId,
          rank,
          source: sourceInfo(source.id, probe),
          input: base.buildInput,
          styleId: String(job.payload.styleId),
        });
        await ds.transaction(async (em) => {
          if (
            !(await em.getRepository(ProjectEntity).existsBy({ id: project.id, merchantId: job.merchantId }))
          ) {
            await em
              .getRepository(ProjectEntity)
              .insert({ id: project.id, merchantId: job.merchantId, title: base.title, currentVersion: 1 });
            await em.getRepository(ProjectVersionEntity).insert({
              merchantId: job.merchantId,
              projectId: project.id,
              version: 1,
              doc: project as never,
              reason: 'create',
              restoredFrom: null,
            });
          }
          await em.getRepository(ClipSuggestionEntity).update(
            { id: s.id, merchantId: job.merchantId, status: 'planned' },
            {
              status: 'ready',
              projectId: project.id,
              hook: base.hook,
              title: base.title,
              buildInput: base.buildInput,
              error: null,
            },
          );
        });
        return { suggestionId: s.id, projectId: project.id, reusedAnalysis: true };
      }
      const product = (job.payload.product ?? {}) as ProductInfo;

      const { segments, aiFixed } = await loadCorrectedTranscript(ds, job.merchantId, source.id);
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
      const title = normalizeThaiSpelling(suggestions.find((x) => x.kind === 'title')?.text ?? source.title);
      const clipWords = await clipCaptionWords(
        llm,
        selectCaptionSegments(segments, s.startWord, s.endWord),
        product.name ? [product.name] : [],
        { merchantId: job.merchantId, workflowRunId: job.workflowRunId },
        aiFixed,
      );
      let projectId = clipProjectId(planRunId, rank);
      const endMs = clipEndWithTail(s.endMs, words[s.endWord + 1]?.startMs, probe.durationMs);
      const ratio: OutputRatio =
        typeof job.payload.ratio === 'string' && job.payload.ratio in OUTPUT_FRAMES
          ? (job.payload.ratio as OutputRatio)
          : '9:16';
      // the frame crops the sides of a wider picture: find where the face is so it stays in view
      const frame = OUTPUT_FRAMES[ratio];
      const faceX =
        probe.video.width / probe.video.height > (frame.width / frame.height) * 1.15
          ? await measureFaceX(ai, storage, original.storageKey, s.startMs, endMs)
          : undefined;
      const buildInput = clipBuildInput({
        plan: {
          startMs: s.startMs,
          endMs,
          words: clipWords.map((w) => ({ ...w, text: normalizeThaiSpelling(w.text) })),
          title,
          ...(hook ? { hook: { text: normalizeThaiSpelling(hook.text), origin: hook.origin } } : {}),
        },
        // older queued jobs have no speech spans: then only filler words are cut
        speech: Array.isArray(job.payload.speech) ? (job.payload.speech as SpanMs[]) : [],
        ...(product.name ? { productName: product.name } : {}),
        ...(ratio !== '9:16' ? { ratio } : {}),
        ...(faceX !== undefined ? { faceX } : {}),
        ...(Array.isArray(job.payload.photos)
          ? { photos: job.payload.photos as ClipBuildInput['photos'] }
          : {}),
        ...(job.payload.frozenStyle ? { frozenStyle: job.payload.frozenStyle as FrozenStyle } : {}),
        ...(job.payload.music ? { music: job.payload.music as ClipBuildInput['music'] } : {}),
      });
      const project = await layoutClip(openLayout, {
        projectId,
        merchantId: job.merchantId,
        workflowRunId: planRunId,
        rank,
        source: sourceInfo(source.id, probe),
        input: buildInput,
        styleId: typeof job.payload.styleId === 'string' ? job.payload.styleId : undefined,
      });
      projectId = project.id;
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
        await em.getRepository(ClipSuggestionEntity).update(
          { id: s.id, status: 'planned' },
          {
            status: 'ready',
            projectId,
            hook: hook?.text ?? null,
            title: title.slice(0, 200),
            error: null,
            buildInput: buildInput as never,
          },
        );
      });
      return { suggestionId: s.id, projectId, hookFallback };
    },
    next(job) {
      const variants = (job.payload.variants ?? []) as { rank: number; styleId: string }[];
      return variants.map((v) => ({
        type: 'clips.build',
        queue: 'ai' as const,
        key: `variant:${v.rank}`,
        maxAttempts: 3,
        timeoutMs: 10 * 60_000,
        payload: {
          sourceId: job.payload.sourceId,
          planRunId: job.payload.planRunId ?? job.workflowRunId,
          baseRank: job.payload.rank,
          rank: v.rank,
          styleId: v.styleId,
        },
      }));
    },
    async onDead(em, job, error) {
      await em.query(
        `UPDATE clip_suggestions SET status = 'failed', error = $4, updated_at = now()
          WHERE workflow_run_id = $1 AND rank = $2 AND merchant_id = $3 AND status = 'planned'`,
        [
          typeof job.payload.planRunId === 'string' ? job.payload.planRunId : job.workflowRunId,
          Number(job.payload.rank),
          job.merchantId,
          error.message.slice(0, 1000),
        ],
      );
    },
  };
}

export function liveToClipsHandlers(deps: LiveToClipsDeps): JobHandler[] {
  return [clipsPlanHandler(deps), clipsBuildHandler(deps)];
}
