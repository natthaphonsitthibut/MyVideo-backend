import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BRAND_LOGO_MAX_BYTES, type BrandKit, BrandKitBody } from '@myvideo/contracts';
import { Body, Controller, Get, HttpException, HttpStatus, Inject, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CurrentMerchant } from '../auth/auth-context.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { BrandService } from './brand.service.js';

/** Reads a raw request body up to `max` bytes (the image is sent as the body, no multipart). */
async function readBody(req: Request, max: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) throw new HttpException('โลโก้ใหญ่เกิน 2 MB', HttpStatus.PAYLOAD_TOO_LARGE);
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

@Controller('brand-kit')
export class BrandController {
  constructor(@Inject(BrandService) private readonly brand: BrandService) {}

  @Get()
  get(@CurrentMerchant() merchantId: string): Promise<BrandKit> {
    return this.brand.get(merchantId);
  }

  @Put()
  save(
    @CurrentMerchant() merchantId: string,
    @Body(new ZodPipe(BrandKitBody)) body: BrandKitBody,
  ): Promise<BrandKit> {
    return this.brand.save(merchantId, body);
  }

  @Put('logo')
  async uploadLogo(@CurrentMerchant() merchantId: string, @Req() req: Request): Promise<BrandKit> {
    return this.brand.saveLogo(merchantId, await readBody(req, BRAND_LOGO_MAX_BYTES));
  }

  @Get('logo')
  async logo(@CurrentMerchant() merchantId: string, @Res() res: Response): Promise<void> {
    const { key, contentType } = await this.brand.logo(merchantId);
    const file = await this.brand.read(key);
    res.status(200);
    res.setHeader('content-type', contentType);
    res.setHeader('content-length', String(file.length));
    // the key changes with every upload, but the URL does not: revalidate
    res.setHeader('cache-control', 'private, no-cache');
    await pipeline(Readable.from(file.body), res).catch(() => undefined);
  }
}
