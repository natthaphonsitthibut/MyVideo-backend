import type { LlmCallContext, LlmPort, TimedWord } from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import {
  TranscriptEditEntity,
  TranscriptEntity,
  TranscriptSegmentEntity,
} from '../db/entities/transcript.entity.js';
import { correctCaptions } from '../highlights/caption-fix.js';
import { FatalJobError, type JobHandler } from '../jobs/handlers.js';

type Segment = { seq: number; words: TimedWord[] };
type Fix = { seq: number; wordIndex: number; text: string };

/** Read immutable input on retries so the shared LLM cache sees identical batches. */
export async function fixTranscriptBatches(
  llm: LlmPort,
  segments: readonly Segment[],
  protectedWords: ReadonlySet<string>,
  context: LlmCallContext,
  signal: AbortSignal,
  progress: (value: number) => Promise<void>,
): Promise<Fix[]> {
  signal.throwIfAborted();
  if (llm.mode === 'rules') return [];
  const edits: Fix[] = [];
  for (let start = 0; start < segments.length; start += 40) {
    signal.throwIfAborted();
    const batch = segments.slice(start, start + 40);
    const selected = batch.map((s, i) => ({
      id: String(s.seq),
      words: s.words,
      context: {
        previous: segments[start + i - 1]?.words.map((w) => w.text).join(' ') ?? null,
        next: segments[start + i + 1]?.words.map((w) => w.text).join(' ') ?? null,
      },
    }));
    const fixed = await correctCaptions(llm, selected, [], { ...context, signal });
    signal.throwIfAborted();
    // No merchant terms means continuation slots are rejected by the shared validator.
    // Keep the positional guard too: transcript edits must always be one token to one token.
    if (fixed.length === batch.reduce((n, s) => n + s.words.length, 0)) {
      let index = 0;
      for (const segment of batch) {
        for (const [wordIndex, word] of segment.words.entries()) {
          const replacement = fixed[index++];
          if (
            replacement &&
            replacement.text !== word.text &&
            replacement.text.trim() &&
            !protectedWords.has(`${segment.seq}:${wordIndex}`) &&
            !/[0-9๐-๙]/u.test(word.text) &&
            replacement.startMs === word.startMs &&
            replacement.endMs === word.endMs
          ) {
            edits.push({ seq: segment.seq, wordIndex, text: replacement.text });
          }
        }
      }
    }
    await progress(Math.min(start + 40, segments.length) / segments.length);
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
      const fixes = await fixTranscriptBatches(
        llm,
        segments,
        new Set(existing.map((e) => `${e.seq}:${e.wordIndex}`)),
        { merchantId: job.merchantId, workflowRunId: job.workflowRunId },
        signal,
        progress,
      );
      // Commit all edits and the pass marker together. A failed/cancelled attempt writes nothing.
      await ds.transaction(async (em) => {
        signal.throwIfAborted();
        const rows: { ai_fix_completed: boolean }[] = await em.query(
          `SELECT ai_fix_completed FROM transcripts WHERE id = $1 AND merchant_id = $2 FOR UPDATE`,
          [transcriptId, job.merchantId],
        );
        if (rows[0]?.ai_fix_completed) return;
        for (const fix of fixes) {
          signal.throwIfAborted();
          await em.query(
            `INSERT INTO transcript_edits (merchant_id, transcript_id, seq, word_index, text, origin)
             VALUES ($1, $2, $3, $4, $5, 'ai') ON CONFLICT (transcript_id, seq, word_index) DO NOTHING`,
            [job.merchantId, transcriptId, fix.seq, fix.wordIndex, fix.text],
          );
        }
        signal.throwIfAborted();
        await em
          .getRepository(TranscriptEntity)
          .update({ id: transcriptId, merchantId: job.merchantId }, { aiFixCompleted: true });
      });
      return { transcriptId, edits: fixes.length };
    },
  };
}
