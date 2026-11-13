import { ListTimingsQuery, type TimingList } from '@myvideo/contracts';
import { Controller, Delete, Get, Inject, Query } from '@nestjs/common';
import { CurrentMerchant } from '../auth/auth-context.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { TimingsService } from './timings.service.js';

@Controller('timings')
export class TimingsController {
  constructor(@Inject(TimingsService) private readonly timings: TimingsService) {}
  @Delete()
  clear(@CurrentMerchant() merchantId: string) {
    return this.timings.clear(merchantId);
  }

  @Get()
  list(
    @CurrentMerchant() merchantId: string,
    @Query(new ZodPipe(ListTimingsQuery)) q: { limit: number },
  ): Promise<TimingList> {
    return this.timings.list(merchantId, q.limit);
  }
}
