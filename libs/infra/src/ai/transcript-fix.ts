import type { LlmCallContext, LlmPort, TimedWord } from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import {
  TranscriptEditEntity,
  TranscriptEntity,
  TranscriptSegmentEntity,
} from '../db/entities/transcript.entity.js';
import { rewriteTranscriptLines } from '../highlights/sentence-fix.js';
import { FatalJobError, type JobHandler } from '../jobs/handlers.js';
import { buildTranscriptContext, type TranscriptContext } from './transcript-context.js';

type Segment = { seq: number; words: TimedWord[] };
/** `text` "" = a continuation: this word was merged into the glossary term on the word before it. */
type Fix = { seq: number; wordIndex: number; text: string };

const BATCH = 40;
const DIGITS = /[0-9๐-๙]/u;

/**
 * The correction batches of the transcript pass. Every segment keeps its token slots, so a correction maps to one
 * word position; a glossary term spanning several heard tokens becomes the term on the first word plus empty
 * continuations. Words the merchant edited, and spans touching them, are never changed; words with digits are never
 * changed (D-027). Inputs are immutable on retries so the LLM cache sees identical batches.
 */
export async function fixTranscriptBatches(
  llm: LlmPort,
  segments: readonly Segment[],
  protectedWords: ReadonlySet<string>,
  context: TranscriptContext | null,
  ctx: LlmCallContext,
  signal: AbortSignal,
  progress: (value: number) => Promise<void>,
): Promise<Fix[]> {
  signal.throwIfAborted();
  if (llm.mode === 'rules') return [];
  const glossary = (context?.terms ?? []).map((t) => ({ term: t.term, heardAs: t.heardAs }));
  const topic = context?.topic ?? '';
  const edits: Fix[] = [];
  for (let start = 0; start < segments.length; start += BATCH) {
    signal.throwIfAborted();
    const batch = segments.slice(start, start + BATCH);
    const lines = batch.map((s, i) => ({
      id: String(s.seq),
      words: s.words.map((w) => w.text),
      previous: segments[start + i - 1]?.words.map((w) => w.text).join(' ') ?? null,
      next: segments[start + i + 1]?.words.map((w) => w.text).join(' ') ?? null,
    }));
    const slots = await rewriteTranscriptLines(llm, lines, { topic, glossary }, { ...ctx, signal });
    signal.throwIfAborted();
    batch.forEach((segment, b) => {
      const tokens = slots[b];
      if (!tokens || tokens.length !== segment.words.length) return;
      for (let j = 0; j < tokens.length; j++) {
        let last = j;
        while (tokens[last + 1] === '') last++;
        const span = segment.words.slice(j, last + 1);
        const touched =
          span.some((_, k) => protectedWords.has(`${segment.seq}:${j + k}`)) ||
          span.some((w) => DIGITS.test(w.text));
        const text = tokens[j] ?? '';
        if (!touched && text.trim() && (last > j || text !== segment.words[j]?.text)) {
          edits.push({ seq: segment.seq, wordIndex: j, text });
          for (let k = j + 1; k <= last; k++) edits.push({ seq: segment.seq, wordIndex: k, text: '' });
        }
        j = last;
      }
    });
    await progress(Math.min(start + BATCH, segments.length) / segments.length);
  }
  return edits;
}

export function transcriptFixHandler({ ds, llm }: { ds: DataSource; llm: LlmPort }): JobHandler {
  return {
    type: 'transcript.fix',
    queue: 'ai',
    async run({ job, signal, progress }) {
      signal.throwIfAborted();
      const transcriptId = String(job.payload.transcriptId ?? '');
      const scope = { merchantId: job.merchantId, transcriptId };
      const transcript = await ds
        .getRepository(TranscriptEntity)
        .findOneBy({ id: transcriptId, merchantId: job.merchantId });
      if (!transcript) throw new FatalJobError('transcript not found');
      if (transcript.aiFixCompleted || llm.mode === 'rules') return { transcriptId, edits: 0 };
      const segments = await ds
        .getRepository(TranscriptSegmentEntity)
        .find({ where: scope, order: { seq: 'ASC' } });
      const existing = await ds.getRepository(TranscriptEditEntity).findBy(scope);
      const llmCtx = { merchantId: job.merchantId, workflowRunId: job.workflowRunId };
      // whole-video context first (topic + glossary); the batches use it
      const context = await buildTranscriptContext(llm, segments, { ...llmCtx, signal });
      signal.throwIfAborted();
      const fixes = await fixTranscriptBatches(
        llm,
        segments,
        new Set(existing.map((e) => `${e.seq}:${e.wordIndex}`)),
        context,
        llmCtx,
        signal,
        progress,
      );
      // Commit all edits, the context and the pass marker together. A failed/cancelled attempt writes nothing.
      await ds.transaction(async (em) => {
        signal.throwIfAborted();
        const rows: { ai_fix_completed: boolean }[] = await em.query(
          `SELECT ai_fix_completed FROM transcripts WHERE id = $1 AND merchant_id = $2 FOR UPDATE`,
          [transcriptId, job.merchantId],
        );
        if (rows[0]?.ai_fix_completed) return;
        // a span is written whole or not at all: if the merchant edited any of its words meanwhile, skip it
        const taken: { seq: number; word_index: number }[] = await em.query(
          `SELECT seq, word_index FROM transcript_edits WHERE transcript_id = $1 AND merchant_id = $2`,
          [transcriptId, job.merchantId],
        );
        const busy = new Set(taken.map((t) => `${t.seq}:${t.word_index}`));
        for (let i = 0; i < fixes.length; i++) {
          const head = fixes[i] as Fix;
          let end = i;
          while (fixes[end + 1]?.text === '' && fixes[end + 1]?.seq === head.seq) end++;
          const span = fixes.slice(i, end + 1);
          i = end;
          if (span.some((f) => busy.has(`${f.seq}:${f.wordIndex}`))) continue;
          for (const fix of span) {
            signal.throwIfAborted();
            await em.query(
              `INSERT INTO transcript_edits (merchant_id, transcript_id, seq, word_index, text, origin)
               VALUES ($1, $2, $3, $4, $5, 'ai') ON CONFLICT (transcript_id, seq, word_index) DO NOTHING`,
              [job.merchantId, transcriptId, fix.seq, fix.wordIndex, fix.text],
            );
          }
        }
        signal.throwIfAborted();
        await em
          .getRepository(TranscriptEntity)
          .update(
            { id: transcriptId, merchantId: job.merchantId },
            { aiFixCompleted: true, aiContext: context as never },
          );
      });
      return { transcriptId, edits: fixes.length, terms: context?.terms.length ?? 0 };
    },
  };
}
