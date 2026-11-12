import { type ClipSuggestion, type ClipsState, STYLE_PACKS } from '@myvideo/contracts';
import {
  BuildClipsUnavailableError,
  ClipSuggestionEntity,
  type Env,
  LiveToClipsUnavailableError,
  RestyleUnavailableError,
  requestBuildClips,
  requestLiveToClips,
  requestRestyle,
} from '@myvideo/infra';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ENV } from '../config/env.module.js';

const CONFLICT_TH: Record<'not_ready' | 'no_transcript', string> = {
  not_ready: 'วิดีโอยังเตรียมไม่เสร็จ รอให้ประมวลผลเสร็จก่อนแล้วค่อยสร้างคลิป',
  no_transcript: 'ยังไม่มีคำถอดเสียง กด "ถอดเสียงวิดีโอนี้" ก่อน แล้วค่อยสร้างคลิปอัตโนมัติ',
};
const RESTYLE_UNAVAILABLE_TH = 'คลิปนี้สร้างก่อนรองรับการเปลี่ยนสไตล์ — สร้างคลิปใหม่อีกครั้ง';
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
    type Run = { id: string; status: ClipsState['status']; input: { styleId?: string } | null };
    const runs: Run[] = await this.ds.query(
      `SELECT id, status, input FROM workflow_runs WHERE merchant_id = $1 AND kind = 'live_to_clips' AND subject_type = 'source'
          AND subject_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [merchantId, sourceId],
    );
    const run = runs[0];
    if (!run) {
      return {
        runId: null,
        status: 'none',
        mode: null,
        phase: 'none',
        styleId: null,
        advice: null,
        clips: [],
      };
    }
    const rows = await this.ds
      .getRepository(ClipSuggestionEntity)
      .find({ where: { merchantId, workflowRunId: run.id }, order: { rank: 'ASC' } });
    const builds: Run[] = await this.ds.query(
      `SELECT id, status, input FROM workflow_runs WHERE merchant_id = $1 AND kind = 'build_clips'
          AND input->>'planRunId' = $2 ORDER BY created_at DESC LIMIT 1`,
      [merchantId, run.id],
    );
    const build = builds[0];
    const plan: {
      result: { advice?: { origin: 'ai' | 'rules'; items: { styleId: string; reason: string }[] } } | null;
    }[] = await this.ds.query(
      `SELECT result FROM jobs WHERE workflow_run_id = $1 AND type = 'clips.plan' AND status = 'succeeded' LIMIT 1`,
      [run.id],
    );
    const raw = plan[0]?.result?.advice;
    const advice = raw
      ? {
          origin: raw.origin,
          items: raw.items.flatMap((x) => {
            const pack = STYLE_PACKS.find((p) => p.id === x.styleId);
            return pack ? [{ styleId: x.styleId, name: pack.name, reason: x.reason }] : [];
          }),
        }
      : null;
    const styleId = run.input?.styleId ?? build?.input?.styleId ?? null;
    let phase: ClipsState['phase'];
    if (run.status === 'pending' || run.status === 'running') phase = 'analysing';
    else if (run.status !== 'succeeded') phase = 'failed';
    else if (run.input?.styleId) phase = 'done';
    else if (build) {
      phase =
        build.status === 'succeeded'
          ? 'done'
          : build.status === 'pending' || build.status === 'running'
            ? 'building'
            : 'failed';
    } else phase = rows.length === 0 ? 'done' : 'choose_style';
    return {
      runId: run.id,
      // what the page polls on: the edit once it started, else the analysis
      status: build?.status ?? run.status,
      mode: rows[0]?.mode ?? this.env.LLM_MODE,
      phase,
      styleId,
      advice,
      clips: rows.filter((r) => r.status !== 'discarded').map(toDto),
    };
  }

  async build(merchantId: string, sourceId: string, styleId: string): Promise<ClipsState> {
    try {
      await requestBuildClips(this.ds, {
        merchantId,
        sourceId,
        styleId,
        maxUnfinishedRuns: this.env.MERCHANT_MAX_ACTIVE_RUNS,
      });
    } catch (err) {
      if (err instanceof BuildClipsUnavailableError) {
        if (err.reason === 'not_found') throw new NotFoundException('Source not found');
        if (err.reason === 'unknown_style')
          throw new BadRequestException({ error: 'unknown_style', message: `ไม่มีสไตล์ "${styleId}"` });
        throw new ConflictException('ยังไม่มีผลวิเคราะห์คลิปของวิดีโอนี้ กด "สร้างคลิปอัตโนมัติ" ก่อน');
      }
      throw err;
    }
    return this.state(merchantId, sourceId);
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

  listStyles(): { items: { id: string; name: string; description: string }[] } {
    return { items: STYLE_PACKS.map(({ id, name, description }) => ({ id, name, description })) };
  }

  async restyle(merchantId: string, projectId: string, styleId: string): Promise<{ runId: string }> {
    try {
      return await requestRestyle(this.ds, {
        merchantId,
        projectId,
        styleId,
        maxUnfinishedRuns: this.env.MERCHANT_MAX_ACTIVE_RUNS,
      });
    } catch (err) {
      if (err instanceof RestyleUnavailableError) {
        if (err.reason === 'not_found') throw new NotFoundException('Project not found');
        if (err.reason === 'unknown_style')
          throw new BadRequestException({ error: 'unknown_style', message: `ไม่มีสไตล์ "${styleId}"` });
        throw new ConflictException(RESTYLE_UNAVAILABLE_TH);
      }
      throw err;
    }
  }

  async discard(merchantId: string, id: string): Promise<ClipSuggestion> {
    const repo = this.ds.getRepository(ClipSuggestionEntity);
    const row = await repo.findOneBy({ id, merchantId });
    if (!row) throw new NotFoundException('Clip suggestion not found');
    await repo.update({ id, merchantId }, { status: 'discarded' });
    return toDto({ ...row, status: 'discarded' } as ClipSuggestionEntity);
  }
}
