import type { TranscriptSegmentPage, TranscriptState } from '@myvideo/contracts';
import {
  type Env,
  requestTranscription,
  TranscriptEntity,
  TranscriptionUnavailableError,
  TranscriptSegmentEntity,
} from '@myvideo/infra';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, MoreThanOrEqual } from 'typeorm';
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

  async segments(
    merchantId: string,
    sourceId: string,
    from: number,
    limit: number,
  ): Promise<TranscriptSegmentPage> {
    await this.assertSource(merchantId, sourceId);
    const t = await this.ds
      .getRepository(TranscriptEntity)
      .findOne({ where: { merchantId, sourceId, status: 'ready' }, order: { createdAt: 'DESC' } });
    if (!t) throw new NotFoundException('No ready transcript');
    const repo = this.ds.getRepository(TranscriptSegmentEntity);
    const rows = await repo.find({
      where: { transcriptId: t.id, merchantId, seq: MoreThanOrEqual(from) },
      order: { seq: 'ASC' },
      take: limit + 1,
    });
    const total = await repo.countBy({ transcriptId: t.id });
    const page = rows.slice(0, limit);
    return {
      transcriptId: t.id,
      items: page.map((s) => ({
        seq: s.seq,
        startMs: s.startMs,
        endMs: s.endMs,
        text: s.text,
        words: s.words.map((w) => ({ text: w.text, startMs: w.startMs, endMs: w.endMs, kind: w.kind })),
      })),
      nextFrom: rows.length > limit ? (rows[limit]?.seq ?? null) : null,
      total,
    };
  }
}
