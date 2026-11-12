import {
  SourceIdParams,
  type TranscriptSegment,
  type TranscriptSegmentPage,
  TranscriptSegmentsQuery,
  type TranscriptState,
  TranscriptWordEdit,
  TranscriptWordParams,
} from '@myvideo/contracts';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query } from '@nestjs/common';
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

  @Put('words/:seq/:index')
  editWord(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(TranscriptWordParams)) p: { id: string; seq: number; index: number },
    @Body(new ZodPipe(TranscriptWordEdit)) body: { text: string },
  ): Promise<TranscriptSegment> {
    return this.transcripts.editWord(merchantId, p.id, p.seq, p.index, body.text);
  }

  @Delete('words/:seq/:index')
  revertWord(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(TranscriptWordParams)) p: { id: string; seq: number; index: number },
  ): Promise<TranscriptSegment> {
    return this.transcripts.revertWord(merchantId, p.id, p.seq, p.index);
  }

  @Post('words/:seq/:index/review')
  @HttpCode(200)
  reviewWord(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(TranscriptWordParams)) p: { id: string; seq: number; index: number },
  ): Promise<TranscriptSegment> {
    return this.transcripts.reviewWord(merchantId, p.id, p.seq, p.index);
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
