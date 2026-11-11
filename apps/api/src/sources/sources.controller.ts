import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AssetParams, SourceIdParams, type SourceSummary, UploadIdParams } from '@myvideo/contracts';
import { Controller, Get, HttpException, HttpStatus, Inject, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CurrentMerchant } from '../auth/auth-context.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { parseRange } from './range.js';
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

  /** Authorised streaming with Range (ARCHITECTURE §12: no public URLs for merchant media in dev). */
  @Get(':id/assets/:kind')
  async asset(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(AssetParams)) p: { id: string; kind: string },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const asset = await this.sources.asset(merchantId, p.id, p.kind);
    const stat = await this.sources.store.stat(asset.storageKey);
    if (!stat) throw new HttpException('File not found', HttpStatus.NOT_FOUND);
    const range = parseRange(req.headers.range, stat.size);
    if (range === null) {
      res.setHeader('content-range', `bytes */${stat.size}`);
      throw new HttpException('Range not satisfiable', HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE);
    }
    const file = await this.sources.store.read(asset.storageKey, range);
    res.status(range ? 206 : 200);
    res.setHeader('content-type', asset.contentType);
    res.setHeader('accept-ranges', 'bytes');
    res.setHeader('content-length', String(file.length));
    res.setHeader('cache-control', 'private, max-age=3600');
    if (range) res.setHeader('content-range', `bytes ${range.start}-${range.end}/${stat.size}`);
    await pipeline(Readable.from(file.body), res).catch(() => undefined); // client aborts are normal while seeking
  }

  @Get(':id')
  get(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(SourceIdParams)) p: { id: string },
  ): Promise<SourceSummary> {
    return this.sources.get(merchantId, p.id);
  }
}
