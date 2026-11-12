import { latestTemplates, type ReviewVideoState, type TemplateVersion } from '@myvideo/contracts';
import {
  type Env,
  type ReviewInput,
  type ReviewResult,
  ReviewVideoUnavailableError,
  requestReviewVideo,
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

const FAILED_TH = 'สร้างวิดีโอไม่สำเร็จ ลองอีกครั้ง';

@Injectable()
export class ReviewVideosService {
  constructor(
    @Inject(DataSource) private readonly ds: DataSource,
    @Inject(ENV) private readonly env: Env,
  ) {}

  templates(): { items: TemplateVersion[] } {
    return { items: latestTemplates() };
  }

  async create(
    merchantId: string,
    body: Pick<ReviewInput, 'sourceIds' | 'templateId' | 'product' | 'roles'>,
    projectId?: string,
  ): Promise<ReviewVideoState> {
    try {
      const { runId } = await requestReviewVideo(this.ds, {
        merchantId,
        sourceIds: body.sourceIds,
        templateId: body.templateId,
        templateVersion: 0,
        product: body.product,
        ...(body.roles ? { roles: body.roles } : {}),
        ...(projectId ? { projectId } : {}),
        maxUnfinishedRuns: this.env.MERCHANT_MAX_ACTIVE_RUNS,
      });
      return this.state(merchantId, runId);
    } catch (err) {
      if (err instanceof ReviewVideoUnavailableError) {
        if (err.reason === 'not_found') throw new NotFoundException('ไม่พบวิดีโอที่เลือก');
        if (err.reason === 'not_ready') throw new ConflictException('มีวิดีโอที่ยังเตรียมไม่เสร็จ รอสักครู่แล้วลองใหม่');
        throw new BadRequestException(err.reason === 'too_many' ? 'เลือกวิดีโอ 1–8 คลิป' : 'ไม่พบเทมเพลตนี้');
      }
      throw err;
    }
  }

  async state(merchantId: string, runId: string): Promise<ReviewVideoState> {
    const runs: { status: ReviewVideoState['status']; input: ReviewInput }[] = await this.ds.query(
      `SELECT status, input FROM workflow_runs WHERE id = $1 AND merchant_id = $2 AND kind = 'review_to_video'`,
      [runId, merchantId],
    );
    const run = runs[0];
    if (!run) throw new NotFoundException('ไม่พบงานนี้');
    const jobs: { result: ReviewResult | null }[] = await this.ds.query(
      `SELECT result FROM jobs WHERE workflow_run_id = $1 AND merchant_id = $2 AND type = 'review.build' AND status = 'succeeded' LIMIT 1`,
      [runId, merchantId],
    );
    const r = jobs[0]?.result ?? null;
    return {
      runId,
      status: run.status,
      templateId: run.input.templateId,
      sourceIds: run.input.sourceIds,
      product: run.input.product,
      result: r
        ? {
            status: r.status,
            projectId: r.status === 'ready' ? r.projectId : null,
            missing: r.status === 'missing' ? r.missing : [],
            shots: r.shots,
          }
        : null,
      error: run.status === 'failed' ? FAILED_TH : null,
    };
  }

  /** Re-applies another template to the footage the project was made from (a new version of the same project). */
  async swap(merchantId: string, projectId: string, templateId: string): Promise<ReviewVideoState> {
    const rows: { input: ReviewInput }[] = await this.ds.query(
      `SELECT r.input FROM projects p
         JOIN project_versions v ON v.project_id = p.id AND v.version = p.current_version
         JOIN workflow_runs r ON r.id = (v.doc->'meta'->>'workflowRunId')::uuid AND r.merchant_id = p.merchant_id
        WHERE p.id = $1 AND p.merchant_id = $2 AND r.kind = 'review_to_video'`,
      [projectId, merchantId],
    );
    const input = rows[0]?.input;
    if (!input) {
      const exists: unknown[] = await this.ds.query(
        `SELECT 1 FROM projects WHERE id = $1 AND merchant_id = $2`,
        [projectId, merchantId],
      );
      if (exists.length === 0) throw new NotFoundException('ไม่พบโปรเจกต์');
      throw new BadRequestException('โปรเจกต์นี้ไม่ได้สร้างจากเทมเพลต');
    }
    return this.create(
      merchantId,
      {
        sourceIds: input.sourceIds,
        templateId,
        product: input.product,
        ...(input.roles ? { roles: input.roles } : {}),
      },
      projectId,
    );
  }
}
