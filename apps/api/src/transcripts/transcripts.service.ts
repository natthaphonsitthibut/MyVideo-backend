import type { TranscriptSegment, TranscriptSegmentPage, TranscriptState } from '@myvideo/contracts';
import {
  type Env,
  requestTranscription,
  TranscriptEditEntity,
  TranscriptEntity,
  TranscriptionUnavailableError,
  TranscriptSegmentEntity,
} from '@myvideo/infra';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
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
          AND subject_id = $2 ORDER BY created_at DESC LIMIT 1`,
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
    await this.ds
      .getRepository(TranscriptEditEntity)
      .delete({ transcriptId: t.id, merchantId, seq, wordIndex: index });
    return withEdits(segment, await this.editsFor(merchantId, t.id, [seq]));
  }
}

/** Corrections over immutable ASR words; merchant and AI markings stay distinct. */
export function withEdits(
  s: TranscriptSegmentEntity,
  edits: Map<string, TranscriptEditEntity>,
): TranscriptSegment {
  let edited = false;
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
      };
    edited = true;
    return {
      text: fix.text,
      startMs: w.startMs,
      endMs: w.endMs,
      kind: w.kind,
      original: fix.origin === 'user' ? w.text : null,
      aiFixed: fix.origin === 'ai',
      heard: w.text,
    };
  });
  return {
    seq: s.seq,
    startMs: s.startMs,
    endMs: s.endMs,
    text: edited ? words.map((w) => w.text).join('') : s.text,
    words,
  };
}
