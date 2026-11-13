import { join } from 'node:path';
import {
  type ChunkSpan,
  type LlmPort,
  offsetChunkSegments,
  planChunks,
  type StoragePort,
  storageKeys,
  type TimedSegment,
  TRANSCRIPT_RECIPE,
} from '@myvideo/domain';
import type { DataSource, EntityManager } from 'typeorm';
import { MediaAssetEntity } from '../db/entities/media-asset.entity.js';
import {
  TranscriptChunkEntity,
  TranscriptEntity,
  TranscriptSegmentEntity,
} from '../db/entities/transcript.entity.js';
import { FatalJobError, type JobHandler, type NextStep } from '../jobs/handlers.js';
import { assertRunCapacity, createRunInTransaction, enqueueInTransaction } from '../jobs/job-store.js';
import { RulesOnlyLlm } from '../llm/structured-llm.js';
import { AUDIO_RECIPE } from '../media/audio-handler.js';
import type { ProbeInfo } from '../media/probe.js';
import { loadSource } from '../media/source-helpers.js';
import { runProcess, withTempDir } from '../process/run-process.js';
import { type AiServiceClient, AiServiceError } from './ai-service.client.js';
import { transcriptFixHandler } from './transcript-fix.js';

export type TranscribeDeps = {
  ds: DataSource;
  storage: StoragePort;
  ai: AiServiceClient;
  llm?: LlmPort;
  /** Longest ASR chunk (default 10 min). */
  maxChunkMs?: number;
  /** While the AI service answers "busy" (409): poll interval (default 5 s) and longest wait (default 20 min). */
  busyRetryMs?: number;
  busyMaxWaitMs?: number;
};

/** One recognised segment as stored per chunk and in the merged original JSON (ms on the source timeline). */
export type StoredSegment = TimedSegment & { avgLogprob: number | null; noSpeechProb: number | null };

type ChunkResult = { language: string; model: string; elapsedMs: number; segments: StoredSegment[] };

export class TranscriptionUnavailableError extends Error {
  constructor(
    readonly reason: 'not_found' | 'not_ready' | 'no_audio',
    message: string,
  ) {
    super(message);
    this.name = 'TranscriptionUnavailableError';
  }
}

/**
 * Starts (or joins) the transcribe run of a source. Idempotent: while a transcribe run of the source is unfinished,
 * that run is returned instead of a new one. The cache check (same audio, model, recipe) happens in `asr.plan`.
 */
export async function requestTranscription(
  ds: DataSource,
  input: { merchantId: string; sourceId: string; maxUnfinishedRuns?: number },
): Promise<{ runId: string; created: boolean }> {
  return ds.transaction(async (em) => {
    const rows: { status: string }[] = await em.query(
      `SELECT status FROM video_sources WHERE id = $1 AND merchant_id = $2 FOR UPDATE`,
      [input.sourceId, input.merchantId],
    );
    const source = rows[0];
    if (!source) throw new TranscriptionUnavailableError('not_found', 'source not found');
    if (source.status !== 'ready')
      throw new TranscriptionUnavailableError('not_ready', 'source is still processing or failed');
    const audio = await em
      .getRepository(MediaAssetEntity)
      .existsBy({ merchantId: input.merchantId, sourceId: input.sourceId, kind: 'audio' });
    if (!audio) throw new TranscriptionUnavailableError('no_audio', 'source has no audio track');
    const open: { id: string }[] = await em.query(
      `SELECT id FROM workflow_runs WHERE merchant_id = $1 AND kind = 'transcribe' AND subject_type = 'source'
          AND subject_id = $2 AND input->>'mode' IS DISTINCT FROM 'selected-clips' AND status IN ('pending', 'running') ORDER BY created_at DESC LIMIT 1`,
      [input.merchantId, input.sourceId],
    );
    if (open[0]) return { runId: open[0].id, created: false };
    if (input.maxUnfinishedRuns) await assertRunCapacity(em, input.merchantId, input.maxUnfinishedRuns);
    const run = await createRunInTransaction(em, {
      merchantId: input.merchantId,
      kind: 'transcribe',
      subjectType: 'source',
      subjectId: input.sourceId,
    });
    await enqueueInTransaction(em, {
      merchantId: input.merchantId,
      workflowRunId: run.id,
      type: 'asr.plan',
      queue: 'ai',
      idempotencyKey: `${run.id}:asr.plan`,
      payload: { sourceId: input.sourceId },
      timeoutMs: 15 * 60_000,
    });
    return { runId: run.id, created: true };
  });
}

async function loadAudio(ds: DataSource, merchantId: string, sourceId: string) {
  const audio = await ds
    .getRepository(MediaAssetEntity)
    .findOneBy({ merchantId, sourceId, kind: 'audio', recipeVersion: AUDIO_RECIPE });
  if (!audio) throw new FatalJobError('ไม่มีเสียงในวิดีโอนี้ จึงถอดเสียงไม่ได้');
  return audio;
}

async function pendingChunkIndexes(em: EntityManager | DataSource, transcriptId: string): Promise<number[]> {
  const rows: { chunk_index: number }[] = await em.query(
    `SELECT chunk_index FROM transcript_chunks WHERE transcript_id = $1 AND status = 'pending' ORDER BY chunk_index`,
    [transcriptId],
  );
  return rows.map((r) => r.chunk_index);
}

/** Marks the transcript failed when one of its steps is dead (a manual retry resumes it). */
async function markTranscriptFailed(
  em: EntityManager,
  job: { merchantId: string; payload: Record<string, unknown> },
  error: { message: string },
) {
  const transcriptId = String(job.payload.transcriptId ?? '');
  if (!transcriptId) return;
  await em.query(
    `UPDATE transcripts SET status = 'failed', error = $3, updated_at = now() WHERE id = $1 AND merchant_id = $2`,
    [transcriptId, job.merchantId, error.message.slice(0, 2000)],
  );
}

const chunkStep = (sourceId: string, transcriptId: string, chunkIndex: number): NextStep => ({
  type: 'asr.chunk',
  queue: 'ai',
  key: String(chunkIndex),
  payload: { sourceId, transcriptId, chunkIndex },
  maxAttempts: 5,
  timeoutMs: 30 * 60_000,
});

const mergeStep = (sourceId: string, transcriptId: string): NextStep => ({
  type: 'asr.merge',
  queue: 'ai',
  payload: { sourceId, transcriptId },
  timeoutMs: 10 * 60_000,
});

const fixStep = (transcriptId: string): NextStep => ({
  type: 'transcript.fix',
  queue: 'ai',
  payload: { transcriptId },
  timeoutMs: 30 * 60_000,
});

/**
 * Transcribe step 1: cache lookup by (source, audio sha256, model, recipe) → VAD → chunk plan (cuts at
 * silences, ≤ 10 min). A transcript left unfinished by an earlier run keeps its done chunks (resume).
 */
export function asrPlanHandler({ ds, storage, ai, maxChunkMs }: TranscribeDeps): JobHandler {
  return {
    type: 'asr.plan',
    queue: 'ai',
    async run({ job, signal, progress }) {
      const { source } = await loadSource(ds, job);
      const probe = source.probe as ProbeInfo | null;
      if (!probe) throw new FatalJobError('source has no probe result');
      const audio = await loadAudio(ds, job.merchantId, source.id);
      const info = await ai.asrInfo({ signal });
      const key = {
        merchantId: job.merchantId,
        sourceId: source.id,
        audioSha256: audio.sha256,
        model: info.model,
        recipeVersion: TRANSCRIPT_RECIPE,
      };
      const transcripts = ds.getRepository(TranscriptEntity);
      const existing = await transcripts.findOneBy(key);
      if (existing?.status === 'ready') return { transcriptId: existing.id, cached: true, pending: [] };
      if (existing && existing.chunkCount > 0) {
        await transcripts.update({ id: existing.id }, { status: 'running', error: null });
        const pending = await pendingChunkIndexes(ds, existing.id);
        return { transcriptId: existing.id, resumed: true, chunks: existing.chunkCount, pending };
      }

      const file = await storage.localPath(audio.storageKey);
      let speech: { startMs: number; endMs: number }[];
      try {
        const vad = await ai.vad(file.path, { signal });
        speech = vad.segments.map((s) => ({ startMs: s.start_ms, endMs: s.end_ms }));
      } finally {
        await file.release();
      }
      await progress(0.8);
      const plan = planChunks(speech, probe.durationMs, { maxMs: maxChunkMs });
      const transcriptId = await ds.transaction(async (em) => {
        await em
          .createQueryBuilder()
          .insert()
          .into(TranscriptEntity)
          .values({ ...key, engine: info.engine, durationMs: probe.durationMs, chunkCount: plan.length })
          .orIgnore()
          .execute();
        const t = await em.getRepository(TranscriptEntity).findOneByOrFail(key);
        if (t.chunkCount !== plan.length) {
          // a row without chunks (plan crashed before this commit): adopt the new plan
          await em.getRepository(TranscriptEntity).update({ id: t.id }, { chunkCount: plan.length });
        }
        if (plan.length > 0) {
          await em
            .createQueryBuilder()
            .insert()
            .into(TranscriptChunkEntity)
            .values(
              plan.map((c) => ({
                merchantId: job.merchantId,
                transcriptId: t.id,
                chunkIndex: c.index,
                startMs: c.startMs,
                endMs: c.endMs,
              })),
            )
            .orIgnore()
            .execute();
        }
        return t.id;
      });
      return {
        transcriptId,
        chunks: plan.length,
        speechMs: speech.reduce((n, s) => n + s.endMs - s.startMs, 0),
        pending: plan.map((c) => c.index),
      };
    },
    next(job, result) {
      if (result.cached) return [fixStep(String(result.transcriptId))];
      const sourceId = String(job.payload.sourceId);
      const transcriptId = String(result.transcriptId);
      const pending = (result.pending as number[]) ?? [];
      if (pending.length === 0) return [mergeStep(sourceId, transcriptId)];
      return pending.map((i) => chunkStep(sourceId, transcriptId, i));
    },
  };
}

/** ffmpeg: one chunk of the 16 kHz FLAC as 16 kHz mono WAV (sample-accurate output seeking). */
export function chunkCutArgs(input: string, chunk: ChunkSpan, out: string): string[] {
  const sec = (ms: number) => (ms / 1000).toFixed(3);
  return [
    '-v',
    'error',
    '-y',
    '-nostdin',
    '-i',
    input,
    '-ss',
    sec(chunk.startMs),
    '-t',
    sec(chunk.endMs - chunk.startMs),
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    out,
  ];
}

/** Transcribe step 2 (one job per chunk): cut → `/asr` → shift onto the source timeline → store on the chunk. */
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/**
 * `/asr` that waits while the service is busy (409: it runs one chunk at a time — e.g. still finishing the chunk of
 * a worker that died). Waiting stays inside this attempt, so busy time never uses up the job's retries. After
 * `maxWaitMs` the 409 is thrown as a normal (retryable) failure. Other 4xx cannot be fixed by a retry → fatal.
 */
export async function asrWhenFree(
  ai: AiServiceClient,
  path: string,
  signal: AbortSignal,
  retryMs: number,
  maxWaitMs: number,
) {
  const started = Date.now();
  for (;;) {
    try {
      return await ai.asr(path, { signal });
    } catch (err) {
      if (!(err instanceof AiServiceError) || err.retryable) throw err;
      if (err.status !== 409) throw new FatalJobError(err.message, { cause: err });
      if (Date.now() - started >= maxWaitMs) throw err;
      await sleep(retryMs, signal);
    }
  }
}

export function asrChunkHandler({ ds, storage, ai, busyRetryMs, busyMaxWaitMs }: TranscribeDeps): JobHandler {
  return {
    type: 'asr.chunk',
    queue: 'ai',
    async run({ job, signal, progress }) {
      const transcriptId = String(job.payload.transcriptId ?? '');
      const chunkIndex = Number(job.payload.chunkIndex);
      const chunk = await ds
        .getRepository(TranscriptChunkEntity)
        .findOneBy({ merchantId: job.merchantId, transcriptId, chunkIndex });
      if (!chunk) throw new FatalJobError(`chunk ${chunkIndex} of transcript ${transcriptId} not found`);
      if (chunk.status === 'done') return { chunkIndex, reused: true };
      const transcript = await ds.getRepository(TranscriptEntity).findOneByOrFail({ id: transcriptId });
      const audio = await loadAudio(ds, job.merchantId, transcript.sourceId);
      if (audio.sha256 !== transcript.audioSha256) throw new FatalJobError('audio changed since the plan');

      const span: ChunkSpan = { index: chunk.chunkIndex, startMs: chunk.startMs, endMs: chunk.endMs };
      const input = await storage.localPath(audio.storageKey);
      let result: ChunkResult;
      try {
        result = await withTempDir('asr', async (dir) => {
          const wav = join(dir, `chunk-${chunkIndex}.wav`);
          await runProcess('ffmpeg', chunkCutArgs(input.path, span, wav), { signal });
          await progress(0.05);
          const res = await asrWhenFree(ai, wav, signal, busyRetryMs ?? 5000, busyMaxWaitMs ?? 20 * 60_000);
          const segments: StoredSegment[] = res.segments.map((s) => ({
            startMs: s.start_ms,
            endMs: s.end_ms,
            text: s.text,
            words: s.words.map((w) => ({ text: w.text, startMs: w.start_ms, endMs: w.end_ms, kind: w.kind })),
            avgLogprob: s.avg_logprob,
            noSpeechProb: s.no_speech_prob,
          }));
          const shifted = offsetChunkSegments(segments, span) as StoredSegment[];
          return { language: res.language, model: res.model, elapsedMs: res.elapsed_ms, segments: shifted };
        });
      } finally {
        await input.release();
      }
      await ds.query(
        `UPDATE transcript_chunks SET status = 'done', result = $3, updated_at = now()
          WHERE id = $1 AND merchant_id = $2 AND status = 'pending'`,
        [chunk.id, job.merchantId, JSON.stringify(result)],
      );
      return { chunkIndex, segments: result.segments.length, elapsedMs: result.elapsedMs };
    },
    // fan-in: the chunk that finds no pending sibling adds the merge (idempotent if two find it at once)
    async next(job, _result, em) {
      const transcriptId = String(job.payload.transcriptId);
      const pending = await pendingChunkIndexes(em, transcriptId);
      return pending.length === 0 ? [mergeStep(String(job.payload.sourceId), transcriptId)] : [];
    },
    onDead: markTranscriptFailed,
  };
}

/** Transcribe step 3: merge chunks → original ASR JSON in storage (immutable) + segment rows → `ready`. */
export function asrMergeHandler({ ds, storage }: TranscribeDeps): JobHandler {
  return {
    type: 'asr.merge',
    queue: 'ai',
    async run({ job, progress }) {
      const transcriptId = String(job.payload.transcriptId ?? '');
      const transcript = await ds
        .getRepository(TranscriptEntity)
        .findOneBy({ id: transcriptId, merchantId: job.merchantId });
      if (!transcript) throw new FatalJobError(`transcript ${transcriptId} not found`);
      if (transcript.status === 'ready') return { transcriptId, reused: true };
      const chunks = await ds
        .getRepository(TranscriptChunkEntity)
        .find({ where: { transcriptId }, order: { chunkIndex: 'ASC' } });
      if (chunks.some((c) => c.status !== 'done' || !c.result))
        throw new FatalJobError('merge started before every chunk was done');
      const results = chunks.map((c) => c.result as unknown as ChunkResult);
      const segments = results.flatMap((r) => r.segments);
      const languages = new Map<string, number>();
      for (const r of results) languages.set(r.language, (languages.get(r.language) ?? 0) + 1);
      const language = [...languages.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

      const original = {
        version: 1,
        sourceId: transcript.sourceId,
        audioSha256: transcript.audioSha256,
        engine: transcript.engine,
        model: transcript.model,
        recipe: transcript.recipeVersion,
        language,
        durationMs: transcript.durationMs,
        chunks: chunks.map((c, i) => ({
          index: c.chunkIndex,
          startMs: c.startMs,
          endMs: c.endMs,
          elapsedMs: results[i]?.elapsedMs ?? null,
        })),
        segments,
      };
      const key = storageKeys.derived(
        job.merchantId,
        transcript.sourceId,
        transcript.id,
        'transcript',
        transcript.recipeVersion,
        'json',
      );
      await storage.put(key, Buffer.from(JSON.stringify(original)), { contentType: 'application/json' });
      await progress(0.5);
      await ds.transaction(async (em) => {
        await em.query(`DELETE FROM transcript_segments WHERE transcript_id = $1`, [transcriptId]);
        const rows = segments.map((s, seq) => ({
          merchantId: job.merchantId,
          transcriptId,
          seq,
          startMs: s.startMs,
          endMs: s.endMs,
          text: s.text,
          words: s.words,
          avgLogprob: s.avgLogprob,
          noSpeechProb: s.noSpeechProb,
        }));
        for (let i = 0; i < rows.length; i += 500) {
          await em.getRepository(TranscriptSegmentEntity).insert(rows.slice(i, i + 500));
        }
        await em.query(
          `UPDATE transcripts SET status = 'ready', storage_key = $2, language = $3, error = NULL, updated_at = now()
            WHERE id = $1`,
          [transcriptId, key, language],
        );
      });
      return {
        transcriptId,
        segments: segments.length,
        words: segments.reduce((n, s) => n + s.words.length, 0),
      };
    },
    next(_job, result) {
      return [fixStep(String(result.transcriptId))];
    },
    onDead: markTranscriptFailed,
  };
}

export function transcribeHandlers(deps: TranscribeDeps): JobHandler[] {
  return [
    asrPlanHandler(deps),
    asrChunkHandler(deps),
    asrMergeHandler(deps),
    transcriptFixHandler({ ds: deps.ds, llm: deps.llm ?? new RulesOnlyLlm() }),
  ];
}
