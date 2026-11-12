import type { RenderSummary } from '@myvideo/contracts';
import type { RenderPreset, StoragePort } from '@myvideo/domain';
import { type Env, RenderEntity, RenderRequestError, requestRender, type StageBundle } from '@myvideo/infra';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ENV } from '../config/env.module.js';
import { STORAGE } from '../storage/storage.module.js';

export const STAGE_BUNDLE = Symbol('STAGE_BUNDLE');

const FAILED_TH = 'ส่งออกวิดีโอไม่สำเร็จ กด "ลองใหม่" เพื่อเริ่มอีกครั้ง';
const NOT_READY_TH = 'ไฟล์ยังเรนเดอร์ไม่เสร็จ';

type Row = {
  id: string;
  project_id: string;
  title: string;
  project_version: number;
  preset: RenderPreset;
  output_key: string | null;
  size_bytes: string | null;
  meta: { durationMs?: number };
  created_at: Date;
  finished_at: Date | null;
  workflow_run_id: string | null;
  run_status: string | null;
  job_status: string | null;
  progress: number | null;
};

/** Read model of renders: status comes from the run (and the output columns), progress from its job. */
const SELECT = `
  SELECT r.id, r.project_id, p.title, r.project_version, r.preset, r.output_key, r.size_bytes, r.meta,
         r.created_at, r.finished_at, r.workflow_run_id, w.status AS run_status, j.status AS job_status, j.progress
    FROM renders r
    JOIN projects p ON p.id = r.project_id
    LEFT JOIN workflow_runs w ON w.id = r.workflow_run_id
    LEFT JOIN LATERAL (
      SELECT status, progress FROM jobs WHERE workflow_run_id = r.workflow_run_id ORDER BY created_at DESC LIMIT 1
    ) j ON true
   WHERE r.merchant_id = $1`;

function summary(r: Row): RenderSummary {
  const status: RenderSummary['status'] = r.output_key
    ? 'ready'
    : r.run_status === 'pending'
      ? r.job_status === 'running'
        ? 'rendering'
        : 'queued'
      : r.run_status === 'running'
        ? 'rendering'
        : r.run_status === 'cancelled'
          ? 'cancelled'
          : 'failed';
  return {
    id: r.id,
    projectId: r.project_id,
    projectTitle: r.title,
    projectVersion: r.project_version,
    preset: r.preset,
    status,
    progress: status === 'ready' ? 1 : Math.min(1, Math.max(0, Number(r.progress ?? 0))),
    runId: r.workflow_run_id,
    error: status === 'failed' ? FAILED_TH : null,
    sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
    durationMs: typeof r.meta?.durationMs === 'number' ? Math.round(r.meta.durationMs) : null,
    createdAt: r.created_at.toISOString(),
    finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
  };
}

@Injectable()
export class RendersService {
  constructor(
    @Inject(DataSource) private readonly ds: DataSource,
    @Inject(ENV) private readonly env: Env,
    @Inject(STAGE_BUNDLE) private readonly bundle: StageBundle,
    @Inject(STORAGE) readonly store: StoragePort,
  ) {}

  async request(
    merchantId: string,
    projectId: string,
    body: { preset: RenderPreset; version?: number },
  ): Promise<RenderSummary> {
    try {
      const { renderId } = await requestRender(this.ds, {
        merchantId,
        projectId,
        version: body.version,
        preset: body.preset,
        stageVersion: this.bundle.version,
        maxUnfinishedRuns: this.env.MERCHANT_MAX_ACTIVE_RUNS,
      });
      return this.get(merchantId, renderId);
    } catch (err) {
      if (err instanceof RenderRequestError)
        throw new NotFoundException(
          err.reason === 'project_not_found' ? 'Project not found' : 'Version not found',
        );
      throw err;
    }
  }

  async get(merchantId: string, id: string): Promise<RenderSummary> {
    const rows: Row[] = await this.ds.query(`${SELECT} AND r.id = $2`, [merchantId, id]);
    if (!rows[0]) throw new NotFoundException('Render not found');
    return summary(rows[0]);
  }

  async list(merchantId: string, projectId?: string): Promise<{ items: RenderSummary[] }> {
    if (projectId) {
      const own: unknown[] = await this.ds.query(
        `SELECT 1 FROM projects WHERE id = $1 AND merchant_id = $2`,
        [projectId, merchantId],
      );
      if (own.length === 0) throw new NotFoundException('Project not found');
    }
    const rows: Row[] = projectId
      ? await this.ds.query(`${SELECT} AND r.project_id = $2 ORDER BY r.created_at DESC LIMIT 50`, [
          merchantId,
          projectId,
        ])
      : await this.ds.query(`${SELECT} ORDER BY r.created_at DESC LIMIT 50`, [merchantId]);
    return { items: rows.map(summary) };
  }

  /** The stored MP4 of a finished render (404 other merchant, 409 not finished). */
  async file(merchantId: string, id: string): Promise<{ key: string; name: string }> {
    const r = await this.ds.getRepository(RenderEntity).findOneBy({ id, merchantId });
    if (!r) throw new NotFoundException('Render not found');
    if (!r.outputKey) throw new ConflictException(NOT_READY_TH);
    return { key: r.outputKey, name: `myvideo-${r.id.slice(-8)}-v${r.projectVersion}-${r.preset}.mp4` };
  }
}
