import { randomUUID } from 'node:crypto';
import type { RunEvent, RunList, RunSummary } from '@myvideo/contracts';
import {
  assertRunCapacity,
  createRunInTransaction,
  type Env,
  enqueueInTransaction,
  JobEntity,
  JobEventEntity,
  WorkflowRunEntity,
} from '@myvideo/infra';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, In, MoreThan } from 'typeorm';
import { ENV } from '../config/env.module.js';
import { toJobSummary } from '../jobs/job-summary.js';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function toRunSummary(r: WorkflowRunEntity, jobs: JobEntity[]): RunSummary {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    subjectType: r.subjectType,
    subjectId: r.subjectId,
    createdAt: r.createdAt.toISOString(),
    finishedAt: iso(r.finishedAt),
    jobs: jobs.sort((a, b) => a.stepIndex - b.stepIndex).map(toJobSummary),
  };
}

export function toRunEvent(e: JobEventEntity): RunEvent {
  return {
    id: e.id,
    kind: e.kind,
    runId: e.workflowRunId,
    jobId: e.jobId,
    status: e.status,
    progress: e.progress,
    at: e.createdAt.toISOString(),
  };
}

/** Cursor = `<createdAt ISO>|<id>` (keyset pagination, newest first). */
const encodeCursor = (r: WorkflowRunEntity) => `${r.createdAt.toISOString()}|${r.id}`;

@Injectable()
export class RunsService {
  constructor(
    @Inject(DataSource) private readonly ds: DataSource,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async list(merchantId: string, limit: number, before?: string): Promise<RunList> {
    const qb = this.ds
      .getRepository(WorkflowRunEntity)
      .createQueryBuilder('r')
      .where('r.merchant_id = :merchantId', { merchantId })
      .orderBy('r.created_at', 'DESC')
      .addOrderBy('r.id', 'DESC')
      .limit(limit + 1);
    if (before) {
      const [at, id] = before.split('|');
      if (at && id && !Number.isNaN(Date.parse(at))) {
        qb.andWhere('(r.created_at, r.id) < (:at, :id)', { at: new Date(at), id });
      }
    }
    const rows = await qb.getMany();
    const page = rows.slice(0, limit);
    const jobs = page.length
      ? await this.ds
          .getRepository(JobEntity)
          .findBy({ merchantId, workflowRunId: In(page.map((r) => r.id)) })
      : [];
    return {
      items: page.map((r) =>
        toRunSummary(
          r,
          jobs.filter((j) => j.workflowRunId === r.id),
        ),
      ),
      nextCursor:
        rows.length > limit && page.length ? encodeCursor(page[page.length - 1] as WorkflowRunEntity) : null,
    };
  }

  async get(merchantId: string, runId: string): Promise<RunSummary> {
    const run = await this.ds.getRepository(WorkflowRunEntity).findOneBy({ id: runId, merchantId });
    if (!run) throw new NotFoundException('Run not found');
    const jobs = await this.ds.getRepository(JobEntity).findBy({ merchantId, workflowRunId: runId });
    return toRunSummary(run, jobs);
  }

  /** Events of a run after `afterId` (merchant-scoped), in id order. */
  async eventsAfter(
    merchantId: string,
    runId: string,
    afterId: string,
    limit = 500,
  ): Promise<JobEventEntity[]> {
    return this.ds.getRepository(JobEventEntity).find({
      where: { merchantId, workflowRunId: runId, id: MoreThan(afterId) },
      order: { id: 'ASC' },
      take: limit,
    });
  }

  async createTestRun(
    merchantId: string,
    body: { ms: number; steps: number; failFirstAttempt: boolean },
  ): Promise<RunSummary> {
    const runId = await this.ds.transaction(async (em) => {
      await assertRunCapacity(em, merchantId, this.env.MERCHANT_MAX_ACTIVE_RUNS);
      const run = await createRunInTransaction(em, { merchantId, kind: 'system_test', input: body });
      await enqueueInTransaction(em, {
        merchantId,
        workflowRunId: run.id,
        type: 'system.sleep',
        queue: 'media',
        idempotencyKey: `system-test:${randomUUID()}`,
        payload: body,
        maxAttempts: 1,
        timeoutMs: body.ms + 30_000,
      });
      return run.id;
    });
    return this.get(merchantId, runId);
  }
}
