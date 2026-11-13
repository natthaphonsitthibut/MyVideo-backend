import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MusicParams, MusicRecord, MusicUploadQuery } from '@myvideo/contracts';
import { type StoragePort, uuidv7 } from '@myvideo/domain';
import { createRunInTransaction, enqueueInTransaction, MusicEntity } from '@myvideo/infra';
import {
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { DataSource } from 'typeorm';
import { CurrentMerchant } from '../auth/auth-context.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { parseRange } from '../sources/range.js';
import { STORAGE } from '../storage/storage.module.js';

@Controller('music')
export class MusicController {
  constructor(
    @Inject(DataSource) private readonly ds: DataSource,
    @Inject(STORAGE) private readonly storage: StoragePort,
  ) {}
  private dto(row: MusicEntity) {
    return MusicRecord.parse({ ...row, sizeBytes: undefined });
  }
  @Get() async list(@CurrentMerchant() m: string) {
    const rows = await this.ds
      .getRepository(MusicEntity)
      .find({ where: { merchantId: m }, order: { createdAt: 'DESC' }, take: 100 });
    return { items: rows.map((r) => this.dto(r)) };
  }
  @Post()
  @HttpCode(202)
  async upload(
    @CurrentMerchant() m: string,
    @Query(new ZodPipe(MusicUploadQuery)) q: { title: string; license: string },
    @Req() req: Request,
  ) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > 30 * 1024 * 1024) throw new HttpException('เพลงใหญ่เกิน 30 MB', HttpStatus.PAYLOAD_TOO_LARGE);
      chunks.push(chunk);
    }
    if (!size) throw new HttpException('เลือกไฟล์เพลงก่อน', HttpStatus.BAD_REQUEST);
    const id = uuidv7(),
      key = `m/${m}/music/${id}/original`,
      stored = await this.storage.put(key, Buffer.concat(chunks));
    const row = await this.ds.transaction(async (em) => {
      const r = await em.getRepository(MusicEntity).save({
        id,
        merchantId: m,
        title: q.title,
        license: q.license,
        storageKey: key,
        sha256: stored.sha256,
        sizeBytes: String(stored.size),
        contentType: 'application/octet-stream',
        status: 'processing',
        durationMs: null,
        analysis: null,
        error: null,
      });
      const run = await createRunInTransaction(em, {
        merchantId: m,
        kind: 'ingest',
        subjectType: 'music',
        subjectId: id,
        input: {},
      });
      await enqueueInTransaction(em, {
        merchantId: m,
        workflowRunId: run.id,
        type: 'music.analyse',
        queue: 'media',
        idempotencyKey: `${run.id}:music`,
        payload: { musicId: id },
        timeoutMs: 240000,
      });
      return r;
    });
    return this.dto(row);
  }
  @Get(':id/file') async file(
    @CurrentMerchant() m: string,
    @Param(new ZodPipe(MusicParams)) p: { id: string },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const row = await this.ds
      .getRepository(MusicEntity)
      .findOneBy({ id: p.id, merchantId: m, status: 'ready' });
    if (!row) throw new NotFoundException('ไม่พบเพลงนี้');
    const range = parseRange(req.headers.range, Number(row.sizeBytes));
    if (range === null) throw new HttpException('Range not satisfiable', 416);
    const file = await this.storage.read(row.storageKey, range ?? undefined);
    res.status(range ? 206 : 200);
    res.setHeader('content-type', row.contentType);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('accept-ranges', 'bytes');
    res.setHeader('content-length', String(file.length));
    if (range) res.setHeader('content-range', `bytes ${range.start}-${range.end}/${row.sizeBytes}`);
    await pipeline(Readable.from(file.body), res).catch(() => undefined);
  }
}
