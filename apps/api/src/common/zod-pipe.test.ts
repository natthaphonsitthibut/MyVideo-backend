import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ZodPipe } from './zod-pipe.js';

describe('ZodPipe', () => {
  const pipe = new ZodPipe(z.object({ name: z.string().min(1), n: z.coerce.number().int() }));
  it('returns parsed data', () => {
    expect(pipe.transform({ name: 'a', n: '3' })).toEqual({ name: 'a', n: 3 });
  });
  it('throws 400 with field paths', () => {
    try {
      pipe.transform({ name: '', n: 'x' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const body = (err as BadRequestException).getResponse() as { issues: { path: string }[] };
      expect(body.issues.map((i) => i.path).sort()).toEqual(['n', 'name']);
    }
  });
});
