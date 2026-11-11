import { JobEntity, refreshRunStatus } from '@myvideo/infra';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

/** Default attempt budget a manual retry adds on top of the attempts already used. */
const RETRY_BUDGET = 3;

@Injectable()
export class JobsService {
  constructor(@Inject(DataSource) private readonly ds: DataSource) {}

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
