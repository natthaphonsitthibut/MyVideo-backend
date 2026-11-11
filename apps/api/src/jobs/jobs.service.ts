import { JobEntity, refreshRunStatus } from '@myvideo/infra';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

/** Default attempt budget a manual retry adds on top of the attempts already used. */
const RETRY_BUDGET = 3;

@Injectable()
export class JobsService {
  constructor(@Inject(DataSource) private readonly ds: DataSource) {}

  /**
   * Waiting jobs (pending | queued | failed) → cancelled at once. A running job gets `cancel_requested`; its
   * worker sees it on the next heartbeat, aborts the handler (killing child processes) and writes `cancelled`.
   */
  async cancel(merchantId: string, jobId: string): Promise<JobEntity> {
    return this.ds.transaction(async (em) => {
      const res: [{ workflow_run_id: string }[], number] = await em.query(
        `UPDATE jobs SET status = 'cancelled', cancel_requested = true, finished_at = now(), queued_at = NULL,
                updated_at = now()
          WHERE id = $1 AND merchant_id = $2 AND status IN ('pending', 'queued', 'failed')
          RETURNING workflow_run_id`,
        [jobId, merchantId],
      );
      if (res[0][0]) {
        await refreshRunStatus(em, res[0][0].workflow_run_id);
      } else {
        const asked: [unknown[], number] = await em.query(
          `UPDATE jobs SET cancel_requested = true, updated_at = now()
            WHERE id = $1 AND merchant_id = $2 AND status = 'running'`,
          [jobId, merchantId],
        );
        if (asked[1] === 0) {
          const exists = await em.getRepository(JobEntity).existsBy({ id: jobId, merchantId });
          if (!exists) throw new NotFoundException('Job not found');
          throw new ConflictException('Job already finished');
        }
      }
      return em.getRepository(JobEntity).findOneByOrFail({ id: jobId, merchantId });
    });
  }

  /** dead | cancelled → pending (manual retry). Scoped by merchant: another merchant's job is "not found". */
  async retry(merchantId: string, jobId: string): Promise<JobEntity> {
    return this.ds.transaction(async (em) => {
      const res: [{ workflow_run_id: string }[], number] = await em.query(
        `UPDATE jobs SET status = 'pending', run_after = now(), max_attempts = attempts + $3, cancel_requested = false,
                finished_at = NULL, progress = 0, updated_at = now()
          WHERE id = $1 AND merchant_id = $2 AND status IN ('dead', 'cancelled')
          RETURNING workflow_run_id`,
        [jobId, merchantId, RETRY_BUDGET],
      );
      const row = res[0][0];
      if (!row) {
        const exists = await em.getRepository(JobEntity).existsBy({ id: jobId, merchantId });
        if (!exists) throw new NotFoundException('Job not found');
        throw new ConflictException('Only dead or cancelled jobs can be retried');
      }
      await refreshRunStatus(em, row.workflow_run_id);
      return em.getRepository(JobEntity).findOneByOrFail({ id: jobId, merchantId });
    });
  }
}
