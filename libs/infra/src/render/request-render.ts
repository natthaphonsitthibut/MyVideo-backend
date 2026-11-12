import { type RenderPreset, renderCacheKey } from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import { RenderEntity } from '../db/entities/render.entity.js';
import { assertRunCapacity, createRunInTransaction, enqueueInTransaction } from '../jobs/job-store.js';

export class RenderRequestError extends Error {
  constructor(readonly reason: 'project_not_found' | 'version_not_found') {
    super(reason);
    this.name = 'RenderRequestError';
  }
}

export type RenderRequestInput = {
  merchantId: string;
  projectId: string;
  /** Default: the project's current version. */
  version?: number;
  preset: RenderPreset;
  stageVersion: string;
  maxUnfinishedRuns?: number;
};

/**
 * Asks for an MP4 of one project version (ARCHITECTURE §4 Render, D-003 cache rule). One `renders` row per
 * (version, preset, stage version): a finished one is returned as is (render cache), one in progress is
 * joined, a failed/cancelled one gets a new run (retry). Row, run and job are written in one transaction.
 */
export async function requestRender(
  ds: DataSource,
  input: RenderRequestInput,
): Promise<{ renderId: string; outcome: 'created' | 'in_progress' | 'cached' | 'restarted' }> {
  return ds.transaction(async (em) => {
    const projects: { id: string; current_version: number }[] = await em.query(
      `SELECT id, current_version FROM projects WHERE id = $1 AND merchant_id = $2 FOR UPDATE`,
      [input.projectId, input.merchantId],
    );
    const project = projects[0];
    if (!project) throw new RenderRequestError('project_not_found');
    const versionNo = input.version ?? project.current_version;
    const versions: { id: string }[] = await em.query(
      `SELECT id FROM project_versions WHERE project_id = $1 AND merchant_id = $2 AND version = $3`,
      [project.id, input.merchantId, versionNo],
    );
    const version = versions[0];
    if (!version) throw new RenderRequestError('version_not_found');
    const cacheKey = renderCacheKey(version.id, input.preset, input.stageVersion);
    const repo = em.getRepository(RenderEntity);
    const existing = await repo.findOne({
      where: { merchantId: input.merchantId, cacheKey },
      lock: { mode: 'pessimistic_write' },
    });
    if (existing?.outputKey) return { renderId: existing.id, outcome: 'cached' };
    if (existing?.workflowRunId) {
      const runs: { status: string }[] = await em.query(`SELECT status FROM workflow_runs WHERE id = $1`, [
        existing.workflowRunId,
      ]);
      const status = runs[0]?.status;
      if (status === 'pending' || status === 'running')
        return { renderId: existing.id, outcome: 'in_progress' };
    }
    if (input.maxUnfinishedRuns) await assertRunCapacity(em, input.merchantId, input.maxUnfinishedRuns);
    const run = await createRunInTransaction(em, {
      merchantId: input.merchantId,
      kind: 'render',
      subjectType: 'project',
      subjectId: project.id,
      input: { version: versionNo, preset: input.preset },
    });
    let renderId: string;
    if (existing) {
      await repo.update({ id: existing.id }, { workflowRunId: run.id });
      renderId = existing.id;
    } else {
      renderId = (
        await repo.save({
          merchantId: input.merchantId,
          projectId: project.id,
          projectVersionId: version.id,
          projectVersion: versionNo,
          preset: input.preset,
          stageVersion: input.stageVersion,
          cacheKey,
          workflowRunId: run.id,
        })
      ).id;
    }
    await enqueueInTransaction(em, {
      merchantId: input.merchantId,
      workflowRunId: run.id,
      type: 'render.video',
      queue: 'render',
      idempotencyKey: `${run.id}:render.video`,
      payload: { renderId },
      maxAttempts: 2,
      timeoutMs: 60 * 60_000,
    });
    return { renderId, outcome: existing ? 'restarted' : 'created' };
  });
}
