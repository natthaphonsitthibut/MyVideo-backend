import type {
  SelectedClipsState,
  TranscriptSegment,
  TranscriptSegmentPage,
  TranscriptState,
} from '@myvideo/contracts';
import {
  type Env,
  requestSelectedClips,
  requestTranscription,
  SelectedClipsError,
  type SelectedRange,
  TranscriptEditEntity,
  TranscriptEntity,
  TranscriptionUnavailableError,
  TranscriptSegmentEntity,
} from '@myvideo/infra';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, In, MoreThanOrEqual } from 'typeorm';
import { ENV } from '../config/env.module.js';

const GENERIC_FAILURE = 'ถอดเสียงไม่สำเร็จ กด "ถอดเสียงอีกครั้ง" เพื่อทำต่อจากจุดที่ค้าง';
const THAI = /[฀-๿]/;

const CONFLICT_TH: Record<'not_ready' | 'no_audio', string> = {
  not_ready: 'วิดีโอยังเตรียมไม่เสร็จ รอให้ประมวลผลเสร็จก่อนแล้วค่อยถอดเสียง',
  no_audio: 'วิดีโอนี้ไม่มีเสียง จึงถอดเสียงไม่ได้',
};

@Injectable()
export class TranscriptsService {
  constructor(
    @Inject(DataSource) private readonly ds: DataSource,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private async assertSource(merchantId: string, sourceId: string): Promise<void> {
    const rows: unknown[] = await this.ds.query(
      `SELECT 1 FROM video_sources WHERE id = $1 AND merchant_id = $2`,
      [sourceId, merchantId],
    );
    if (rows.length === 0) throw new NotFoundException('Source not found');
  }

  /** Newest transcript of the source (any status). */
  private newest(merchantId: string, sourceId: string): Promise<TranscriptEntity | null> {
    return this.ds
      .getRepository(TranscriptEntity)
      .findOne({ where: { merchantId, sourceId }, order: { createdAt: 'DESC' } });
  }

  async state(merchantId: string, sourceId: string): Promise<TranscriptState> {
    await this.assertSource(merchantId, sourceId);
    const runs: { id: string; status: string }[] = await this.ds.query(
      `SELECT id, status FROM workflow_runs WHERE merchant_id = $1 AND kind = 'transcribe' AND subject_type = 'source'
          AND subject_id = $2 AND input->>'mode' IS DISTINCT FROM 'selected-clips' ORDER BY created_at DESC LIMIT 1`,
      [merchantId, sourceId],
    );
    const run = runs[0] ?? null;
    const t = await this.newest(merchantId, sourceId);
    const counts: { done: number; segs: number }[] = t
      ? await this.ds.query(
          `SELECT (SELECT count(*)::int FROM transcript_chunks WHERE transcript_id = $1 AND status = 'done') AS done,
                  (SELECT count(*)::int FROM transcript_segments WHERE transcript_id = $1) AS segs`,
          [t.id],
        )
      : [];
    const runActive = run?.status === 'pending' || run?.status === 'running';
    let status: TranscriptState['status'];
    if (runActive) status = 'running';
    else if (t) status = t.status;
    else status = run ? (run.status === 'succeeded' ? 'ready' : 'failed') : 'none';
    // a transcript left `running` by a run that ended (cancelled/failed) is shown as failed: it can be resumed
    if (status === 'running' && !runActive) status = 'failed';
    const err = t?.error ?? null;
    return {
      status,
      transcriptId: t?.id ?? null,
      runId: run?.id ?? null,
      chunkCount: t?.chunkCount ?? 0,
      chunksDone: counts[0]?.done ?? 0,
      segmentCount: counts[0]?.segs ?? 0,
      durationMs: t?.durationMs ?? null,
      language: t?.language ?? null,
      model: t?.model ?? null,
      error: status === 'failed' ? (err && THAI.test(err) ? err : GENERIC_FAILURE) : null,
      ...(await this.aiCounts(merchantId, t?.id ?? null)),
    };
  }

  async start(merchantId: string, sourceId: string): Promise<TranscriptState> {
    try {
      await requestTranscription(this.ds, {
        merchantId,
        sourceId,
        maxUnfinishedRuns: this.env.MERCHANT_MAX_ACTIVE_RUNS,
      });
    } catch (err) {
      if (err instanceof TranscriptionUnavailableError) {
        if (err.reason === 'not_found') throw new NotFoundException('Source not found');
        throw new ConflictException(CONFLICT_TH[err.reason]);
      }
      throw err;
    }
    return this.state(merchantId, sourceId);
  }

  async selectedClips(merchantId: string, sourceId: string): Promise<SelectedClipsState> {
    await this.assertSource(merchantId, sourceId);
    const [run] = (await this.ds.query(
      `SELECT id FROM workflow_runs WHERE merchant_id = $1 AND subject_id = $2 AND kind = 'transcribe' AND input->>'mode' = 'selected-clips' ORDER BY created_at DESC LIMIT 1`,
      [merchantId, sourceId],
    )) as { id: string }[];
    if (!run) return { runId: null, clips: [] };
    const jobs = (await this.ds.query(
      `SELECT id, status, progress, payload FROM jobs WHERE workflow_run_id = $1 AND merchant_id = $2 AND type = 'asr.selected-clip' ORDER BY (payload->>'startMs')::int`,
      [run.id, merchantId],
    )) as { id: string; status: string; progress: number; payload: SelectedRange & { projectId: string } }[];
    return {
      runId: run.id,
      clips: jobs.map((j) => ({
        ...j.payload,
        jobId: j.id,
        status:
          j.status === 'succeeded'
            ? 'ready'
            : j.status === 'dead'
              ? 'failed'
              : j.status === 'cancelled'
                ? 'cancelled'
                : j.status === 'running'
                  ? 'running'
                  : 'pending',
        progress: j.progress,
      })),
    };
  }

  async startSelectedClips(
    merchantId: string,
    sourceId: string,
    body: { requestId: string; ranges: SelectedRange[] },
  ): Promise<SelectedClipsState> {
    try {
      await requestSelectedClips(this.ds, {
        merchantId,
        sourceId,
        ...body,
        maxUnfinishedRuns: this.env.MERCHANT_MAX_ACTIVE_RUNS,
      });
    } catch (err) {
      if (!(err instanceof SelectedClipsError)) throw err;
      if (err.reason === 'not_found') throw new NotFoundException(err.message);
      if (err.reason === 'not_ready') throw new ConflictException(err.message);
      throw new BadRequestException(err.message);
    }
    return this.selectedClips(merchantId, sourceId);
  }

  private async readyTranscript(merchantId: string, sourceId: string): Promise<TranscriptEntity> {
    await this.assertSource(merchantId, sourceId);
    const t = await this.ds
      .getRepository(TranscriptEntity)
      .findOne({ where: { merchantId, sourceId, status: 'ready' }, order: { createdAt: 'DESC' } });
    if (!t) throw new NotFoundException('No ready transcript');
    return t;
  }

  /** Corrections of these segments, keyed `seq:index`. */
  private async editsFor(
    merchantId: string,
    transcriptId: string,
    seqs: number[],
  ): Promise<Map<string, TranscriptEditEntity>> {
    if (seqs.length === 0) return new Map();
    const rows = await this.ds
      .getRepository(TranscriptEditEntity)
      .find({ where: { merchantId, transcriptId, seq: In(seqs) } });
    return new Map(rows.map((r) => [`${r.seq}:${r.wordIndex}`, r]));
  }

  async segments(
    merchantId: string,
    sourceId: string,
    from: number,
    limit: number,
  ): Promise<TranscriptSegmentPage> {
    const t = await this.readyTranscript(merchantId, sourceId);
    const repo = this.ds.getRepository(TranscriptSegmentEntity);
    const rows = await repo.find({
      where: { transcriptId: t.id, merchantId, seq: MoreThanOrEqual(from) },
      order: { seq: 'ASC' },
      take: limit + 1,
    });
    const total = await repo.countBy({ transcriptId: t.id });
    const page = rows.slice(0, limit);
    const edits = await this.editsFor(
      merchantId,
      t.id,
      page.map((s) => s.seq),
    );
    return {
      transcriptId: t.id,
      items: page.map((s) => withEdits(s, edits)),
      nextFrom: rows.length > limit ? (rows[limit]?.seq ?? null) : null,
      total,
    };
  }

  private async word(merchantId: string, sourceId: string, seq: number, index: number) {
    const t = await this.readyTranscript(merchantId, sourceId);
    const segment = await this.ds
      .getRepository(TranscriptSegmentEntity)
      .findOneBy({ transcriptId: t.id, merchantId, seq });
    if (!segment || index >= segment.words.length) throw new NotFoundException('No such word');
    return { t, segment };
  }

  /** Stores the correction in the user layer (upsert); the ASR rows and stored JSON stay untouched. */
  async editWord(
    merchantId: string,
    sourceId: string,
    seq: number,
    index: number,
    text: string,
  ): Promise<TranscriptSegment> {
    const { t, segment } = await this.word(merchantId, sourceId, seq, index);
    // the merchant takes over a word the AI merged into a name: the AI merge of that span goes first
    await this.deleteAiSpan(merchantId, t.id, segment, index);
    if (segment.words[index]?.text === text) {
      // same as recognised → no correction needed
      await this.ds
        .getRepository(TranscriptEditEntity)
        .delete({ transcriptId: t.id, merchantId, seq, wordIndex: index });
    } else {
      await this.ds.query(
        `INSERT INTO transcript_edits (merchant_id, transcript_id, seq, word_index, text, origin) VALUES ($1, $2, $3, $4, $5, 'user')
         ON CONFLICT (transcript_id, seq, word_index) DO UPDATE SET text = EXCLUDED.text, origin = 'user', updated_at = now()`,
        [merchantId, t.id, seq, index, text],
      );
    }
    return withEdits(segment, await this.editsFor(merchantId, t.id, [seq]));
  }

  async revertWord(
    merchantId: string,
    sourceId: string,
    seq: number,
    index: number,
  ): Promise<TranscriptSegment> {
    const { t, segment } = await this.word(merchantId, sourceId, seq, index);
    // reverting a merged name restores every word of its span
    await this.deleteAiSpan(merchantId, t.id, segment, index);
    await this.ds
      .getRepository(TranscriptEditEntity)
      .delete({ transcriptId: t.id, merchantId, seq, wordIndex: index });
    return withEdits(segment, await this.editsFor(merchantId, t.id, [seq]));
  }

  /** AI corrections (a merged name counts once) and those not yet checked by the merchant. */
  private async aiCounts(
    merchantId: string,
    transcriptId: string | null,
  ): Promise<{ aiFixedCount: number; needsReviewCount: number }> {
    if (!transcriptId) return { aiFixedCount: 0, needsReviewCount: 0 };
    const rows: { fixed: number; open: number }[] = await this.ds.query(
      `SELECT count(*)::int AS fixed, count(*) FILTER (WHERE reviewed_at IS NULL)::int AS open
         FROM transcript_edits WHERE transcript_id = $1 AND merchant_id = $2 AND origin = 'ai' AND text <> ''`,
      [transcriptId, merchantId],
    );
    return { aiFixedCount: rows[0]?.fixed ?? 0, needsReviewCount: rows[0]?.open ?? 0 };
  }

  /** The merchant checked an AI correction and keeps it (a merged name: the whole span). */
  async reviewWord(
    merchantId: string,
    sourceId: string,
    seq: number,
    index: number,
  ): Promise<TranscriptSegment> {
    const { t, segment } = await this.word(merchantId, sourceId, seq, index);
    const edits = await this.editsFor(merchantId, t.id, [seq]);
    const span = aiSpanAt(edits, seq, index, segment.words.length) ?? [index, index];
    const head = edits.get(`${seq}:${span[0]}`);
    if (head?.origin !== 'ai') throw new NotFoundException('This word has no AI correction');
    await this.ds.query(
      `UPDATE transcript_edits SET reviewed_at = now(), updated_at = now()
        WHERE transcript_id = $1 AND merchant_id = $2 AND seq = $3 AND origin = 'ai' AND word_index BETWEEN $4 AND $5`,
      [t.id, merchantId, seq, span[0], span[1]],
    );
    return withEdits(segment, await this.editsFor(merchantId, t.id, [seq]));
  }

  private async deleteAiSpan(
    merchantId: string,
    transcriptId: string,
    segment: TranscriptSegmentEntity,
    index: number,
  ): Promise<void> {
    const edits = await this.editsFor(merchantId, transcriptId, [segment.seq]);
    const span = aiSpanAt(edits, segment.seq, index, segment.words.length);
    if (!span) return;
    await this.ds.query(
      `DELETE FROM transcript_edits WHERE transcript_id = $1 AND merchant_id = $2 AND seq = $3 AND origin = 'ai'
         AND word_index BETWEEN $4 AND $5`,
      [transcriptId, merchantId, segment.seq, span[0], span[1]],
    );
  }
}

/**
 * The AI-merged span (head + empty continuations) that contains word `index`, as [first, last]; null when the word is
 * not part of a merge.
 */
export function aiSpanAt(
  edits: Map<string, Pick<TranscriptEditEntity, 'origin' | 'text'>>,
  seq: number,
  index: number,
  length: number,
): [number, number] | null {
  const isCont = (i: number) => {
    const e = edits.get(`${seq}:${i}`);
    return e?.origin === 'ai' && e.text === '';
  };
  let first = index;
  while (first > 0 && isCont(first)) first--;
  const head = edits.get(`${seq}:${first}`);
  if (head?.origin !== 'ai' || head.text === '') return null;
  let last = first;
  while (last + 1 < length && isCont(last + 1)) last++;
  return last > first ? [first, last] : null;
}

/** Corrections over immutable ASR words; merchant and AI markings stay distinct. */
export function withEdits(
  s: TranscriptSegmentEntity,
  edits: Map<string, TranscriptEditEntity>,
): TranscriptSegment {
  let edited = false;
  let head = -1;
  const words = s.words.map((w, i) => {
    const fix = edits.get(`${s.seq}:${i}`);
    if (fix === undefined)
      return {
        text: w.text,
        startMs: w.startMs,
        endMs: w.endMs,
        kind: w.kind,
        original: null,
        aiFixed: false,
        heard: null,
        mergedInto: null,
        needsReview: false,
      };
    edited = true;
    // an empty AI edit is a continuation of the name on the word before (kept for index alignment, not shown)
    const continuation = fix.origin === 'ai' && fix.text === '' && head >= 0;
    if (!continuation) head = i;
    return {
      text: fix.text,
      startMs: w.startMs,
      endMs: w.endMs,
      kind: w.kind,
      original: fix.origin === 'user' ? w.text : null,
      aiFixed: fix.origin === 'ai',
      heard: w.text,
      mergedInto: continuation ? head : null,
      needsReview: fix.origin === 'ai' && !continuation && fix.reviewedAt === null,
    };
  });
  // the merged word's heard text covers its whole span
  for (const w of words) {
    if (w.mergedInto === null) continue;
    const h = words[w.mergedInto];
    if (h) h.heard = `${h.heard ?? ''} ${w.heard ?? ''}`.trim();
  }
  return {
    seq: s.seq,
    startMs: s.startMs,
    endMs: s.endMs,
    text: edited ? words.map((w) => w.text).join('') : s.text,
    words,
  };
}
