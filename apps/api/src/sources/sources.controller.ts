import { SourceIdParams, type SourceSummary, UploadIdParams } from '@myvideo/contracts';
import { Controller, Get, Inject, Param } from '@nestjs/common';
import { CurrentMerchant } from '../auth/auth-context.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { SourcesService } from './sources.service.js';

@Controller('sources')
export class SourcesController {
  constructor(@Inject(SourcesService) private readonly sources: SourcesService) {}

  @Get('by-upload/:uploadId')
  byUpload(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(UploadIdParams)) p: { uploadId: string },
  ): Promise<SourceSummary> {
    return this.sources.finalizeUpload(merchantId, p.uploadId);
  }

  @Get(':id')
  get(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(SourceIdParams)) p: { id: string },
  ): Promise<SourceSummary> {
    return this.sources.get(merchantId, p.id);
  }
}
