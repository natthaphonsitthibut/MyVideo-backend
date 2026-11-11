import { JobIdParams, type JobSummary } from '@myvideo/contracts';
import { Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { CurrentMerchant } from '../auth/auth-context.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { toJobSummary } from './job-summary.js';
import { JobsService } from './jobs.service.js';

@Controller('jobs')
export class JobsController {
  constructor(@Inject(JobsService) private readonly jobs: JobsService) {}

  @Post(':id/retry')
  @HttpCode(200)
  async retry(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(JobIdParams)) p: { id: string },
  ): Promise<JobSummary> {
    return toJobSummary(await this.jobs.retry(merchantId, p.id));
  }
}
