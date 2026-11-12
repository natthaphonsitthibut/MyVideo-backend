import type { ClipSuggestion, ClipsState } from '@myvideo/contracts';
import {
  ClipSuggestionEntity,
  type Env,
  LiveToClipsUnavailableError,
  requestLiveToClips,
} from '@myvideo/infra';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ENV } from '../config/env.module.js';

const CONFLICT_TH: Record<'not_ready' | 'no_transcript', string> = {
  not_ready: 'วิดีโอยังเตรียมไม่เสร็จ รอให้ประมวลผลเสร็จก่อนแล้วค่อยสร้างคลิป',
  no_transcript: 'ยังไม่มีคำถอดเสียง กด "ถอดเสียงวิดีโอนี้" ก่อน แล้วค่อยสร้างคลิปอัตโนมัติ',
};
const BUILD_FAILED_TH = 'สร้างคลิปนี้ไม่สำเร็จ ลองกด "สร้างใหม่" อีกครั้ง';

function toDto(r: ClipSuggestionEntity): ClipSuggestion {
  return {
    id: r.id,
    rank: r.rank,
    status: r.status,
    startMs: r.startMs,
    endMs: r.endMs,
    score: Math.round(r.score),
    type: r.type,
    reason: r.reason,
    quote: r.quote,
    hook: r.hook,
    title: r.title,
    origin: r.origin === 'llm' ? 'llm' : 'rules',
    projectId: r.projectId,
    error: r.status === 'failed' ? BUILD_FAILED_TH : null,
  };
}

@Injectable()
export class ClipsService {
  constructor(
    @Inject(DataSource) private readonly ds: DataSource,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async state(merchantId: string, sourceId: string): Promise<ClipsState> {
    const src: unknown[] = await this.ds.query(
      `SELECT 1 FROM video_sources WHERE id = $1 AND merchant_id = $2`,
      [sourceId, merchantId],
    );
    if (src.length === 0) throw new NotFoundException('Source not found');
    const runs: { id: string; status: ClipsState['status'] }[] = await this.ds.query(
      `SELECT id, status FROM workflow_runs WHERE merchant_id = $1 AND kind = 'live_to_clips' AND subject_type = 'source'
          AND subject_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [merchantId, sourceId],
    );
    const run = runs[0];
    if (!run) return { runId: null, status: 'none', mode: null, clips: [] };
    const rows = await this.ds
      .getRepository(ClipSuggestionEntity)
      .find({ where: { merchantId, workflowRunId: run.id }, order: { rank: 'ASC' } });
    return {
      runId: run.id,
      status: run.status,
      mode: rows[0]?.mode ?? this.env.LLM_MODE,
      clips: rows.filter((r) => r.status !== 'discarded').map(toDto),
    };
  }

  async generate(
    merchantId: string,
    sourceId: string,
    body: { productName?: string; fresh?: boolean; styleId?: string },
  ): Promise<ClipsState> {
    try {
      await requestLiveToClips(this.ds, {
        merchantId,
        sourceId,
        product: body.productName ? { name: body.productName } : {},
        fresh: body.fresh,
        ...(body.styleId ? { styleId: body.styleId } : {}),
        maxUnfinishedRuns: this.env.MERCHANT_MAX_ACTIVE_RUNS,
      });
    } catch (err) {
      if (err instanceof LiveToClipsUnavailableError) {
        if (err.reason === 'not_found') throw new NotFoundException('Source not found');
        throw new ConflictException(CONFLICT_TH[err.reason]);
      }
      throw err;
    }
    return this.state(merchantId, sourceId);
  }

  async discard(merchantId: string, id: string): Promise<ClipSuggestion> {
    const repo = this.ds.getRepository(ClipSuggestionEntity);
    const row = await repo.findOneBy({ id, merchantId });
    if (!row) throw new NotFoundException('Clip suggestion not found');
    await repo.update({ id, merchantId }, { status: 'discarded' });
    return toDto({ ...row, status: 'discarded' } as ClipSuggestionEntity);
  }
}
