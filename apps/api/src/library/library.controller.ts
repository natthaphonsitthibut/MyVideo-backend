import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { LibrarySoundParams } from '@myvideo/contracts';
import { type Env, soundLibraryFile } from '@myvideo/infra';
import { Controller, Get, HttpException, HttpStatus, Inject, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodPipe } from '../common/zod-pipe.js';
import { ENV } from '../config/env.module.js';
import { parseRange } from '../sources/range.js';

/** Product library files (D-026): the same for every merchant, still behind the session like all media. */
@Controller('library')
export class LibraryController {
  constructor(@Inject(ENV) private readonly env: Env) {}

  @Get('sounds/:id')
  async sound(
    @Param(new ZodPipe(LibrarySoundParams)) p: { id: string },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    let path: string;
    try {
      path = soundLibraryFile(this.env.SOUND_LIBRARY_DIR, p.id);
    } catch {
      throw new HttpException('No such library sound', HttpStatus.NOT_FOUND);
    }
    const size = await stat(path).then(
      (s) => s.size,
      () => null,
    );
    if (size === null) throw new HttpException('Library sound file is not installed', HttpStatus.NOT_FOUND);
    const range = parseRange(req.headers.range, size);
    if (range === null) {
      res.setHeader('content-range', `bytes */${size}`);
      throw new HttpException('Range not satisfiable', HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE);
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? size - 1;
    res.status(range ? 206 : 200);
    res.setHeader('content-type', 'audio/wav');
    res.setHeader('accept-ranges', 'bytes');
    res.setHeader('content-length', String(end - start + 1));
    res.setHeader('cache-control', 'private, max-age=31536000, immutable');
    if (range) res.setHeader('content-range', `bytes ${start}-${end}/${size}`);
    await pipeline(createReadStream(path, { start, end }), res).catch(() => undefined); // aborts while seeking
  }
}
