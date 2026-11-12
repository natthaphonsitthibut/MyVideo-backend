import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AssetParams,
  DeleteSourceQuery,
  ListSourcesQuery,
  type SourceDependents,
  SourceIdParams,
  type SourceList,
  type SourceSummary,
  SpriteSheetParams,
  type UploadConfig,
  UploadIdParams,
} from '@myvideo/contracts';
import { storageKeys, UPLOAD_EXTENSIONS } from '@myvideo/domain';
import type { Env } from '@myvideo/infra';
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { CurrentMerchant } from '../auth/auth-context.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { ENV } from '../config/env.module.js';
import { parseRange } from './range.js';
import { SourcesService } from './sources.service.js';

@Controller('sources')
export class SourcesController {
  constructor(
    @Inject(SourcesService) private readonly sources: SourcesService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('upload-config')
  uploadConfig(): UploadConfig {
    return {
      endpoint: '/uploads',
      maxBytes: this.env.UPLOAD_MAX_BYTES,
      extensions: [...UPLOAD_EXTENSIONS],
      chunkBytes: 8 * 1024 * 1024,
    };
  }

  @Get()
  list(
    @CurrentMerchant() merchantId: string,
    @Query(new ZodPipe(ListSourcesQuery)) q: { limit: number; before?: string },
  ): Promise<SourceList> {
    return this.sources.list(merchantId, q.limit, q.before);
  }

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

  @Get(':id/sprites/:sheet')
  async spriteSheet(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(SpriteSheetParams)) p: { id: string; sheet: number },
    @Res() res: Response,
  ): Promise<void> {
    const asset = await this.sources.asset(merchantId, p.id, 'sprites');
    if (p.sheet >= Number(asset.meta.sheets ?? 0))
      throw new HttpException('Sheet not found', HttpStatus.NOT_FOUND);
    const key = storageKeys.spriteSheet(merchantId, p.id, asset.id, asset.recipeVersion, p.sheet);
    const file = await this.sources.store.read(key);
    res.status(200);
    res.setHeader('content-type', 'image/jpeg');
    res.setHeader('content-length', String(file.length));
    res.setHeader('cache-control', 'private, max-age=86400, immutable');
    await pipeline(Readable.from(file.body), res).catch(() => undefined);
  }

  @Get(':id/dependents')
  dependents(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(SourceIdParams)) p: { id: string },
  ): Promise<SourceDependents> {
    return this.sources.dependents(merchantId, p.id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(SourceIdParams)) p: { id: string },
    @Query(new ZodPipe(DeleteSourceQuery)) q: { withProjects: boolean },
  ): Promise<void> {
    await this.sources.delete(merchantId, p.id, q.withProjects);
  }

  @Get(':id')
  get(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(SourceIdParams)) p: { id: string },
  ): Promise<SourceSummary> {
    return this.sources.get(merchantId, p.id);
  }
}
