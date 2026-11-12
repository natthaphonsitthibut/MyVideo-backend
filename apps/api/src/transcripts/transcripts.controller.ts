import {
  SourceIdParams,
  type TranscriptSegmentPage,
  TranscriptSegmentsQuery,
  type TranscriptState,
} from '@myvideo/contracts';
import { Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { CurrentMerchant } from '../auth/auth-context.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { TranscriptsService } from './transcripts.service.js';

@Controller('sources/:id/transcript')
export class TranscriptsController {
  constructor(@Inject(TranscriptsService) private readonly transcripts: TranscriptsService) {}

  @Get()
  state(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(SourceIdParams)) p: { id: string },
  ): Promise<TranscriptState> {
    return this.transcripts.state(merchantId, p.id);
  }

  @Post()
  @HttpCode(202)
  start(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(SourceIdParams)) p: { id: string },
  ): Promise<TranscriptState> {
    return this.transcripts.start(merchantId, p.id);
  }

  @Get('segments')
  segments(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(SourceIdParams)) p: { id: string },
    @Query(new ZodPipe(TranscriptSegmentsQuery)) q: { from: number; limit: number },
  ): Promise<TranscriptSegmentPage> {
    return this.transcripts.segments(merchantId, p.id, q.from, q.limit);
  }
}
