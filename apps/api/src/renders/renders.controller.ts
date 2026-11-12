import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  ProjectIdParams,
  RenderFileQuery,
  RenderIdParams,
  type RenderSummary,
  RequestRenderBody,
} from '@myvideo/contracts';
import type { RenderPreset } from '@myvideo/domain';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { CurrentMerchant } from '../auth/auth-context.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { parseRange } from '../sources/range.js';
import { RendersService } from './renders.service.js';

@Controller()
export class RendersController {
  constructor(@Inject(RendersService) private readonly renders: RendersService) {}

  @Post('projects/:id/renders')
  @HttpCode(200)
  request(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(ProjectIdParams)) p: { id: string },
    @Body(new ZodPipe(RequestRenderBody)) body: { preset: RenderPreset; version?: number },
  ): Promise<RenderSummary> {
    return this.renders.request(merchantId, p.id, body);
  }

  @Get('projects/:id/renders')
  forProject(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(ProjectIdParams)) p: { id: string },
  ): Promise<{ items: RenderSummary[] }> {
    return this.renders.list(merchantId, p.id);
  }

  @Get('renders')
  list(@CurrentMerchant() merchantId: string): Promise<{ items: RenderSummary[] }> {
    return this.renders.list(merchantId);
  }

  @Get('renders/:id')
  get(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(RenderIdParams)) p: { id: string },
  ): Promise<RenderSummary> {
    return this.renders.get(merchantId, p.id);
  }

  /** Authorised MP4 with byte ranges (plays in a `<video>`); `download=1` → attachment. */
  @Get('renders/:id/file')
  async file(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(RenderIdParams)) p: { id: string },
    @Query(new ZodPipe(RenderFileQuery)) q: { download?: '0' | '1' },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const f = await this.renders.file(merchantId, p.id);
    const stat = await this.renders.store.stat(f.key);
    if (!stat) throw new HttpException('File not found', HttpStatus.NOT_FOUND);
    const range = parseRange(req.headers.range, stat.size);
    if (range === null) {
      res.setHeader('content-range', `bytes */${stat.size}`);
      throw new HttpException('Range not satisfiable', HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE);
    }
    const file = await this.renders.store.read(f.key, range);
    res.status(range ? 206 : 200);
    res.setHeader('content-type', 'video/mp4');
    res.setHeader('accept-ranges', 'bytes');
    res.setHeader('content-length', String(file.length));
    res.setHeader('cache-control', 'private, max-age=3600');
    if (q.download === '1') res.setHeader('content-disposition', `attachment; filename="${f.name}"`);
    if (range) res.setHeader('content-range', `bytes ${range.start}-${range.end}/${stat.size}`);
    await pipeline(Readable.from(file.body), res).catch(() => undefined); // client aborts are normal
  }
}
