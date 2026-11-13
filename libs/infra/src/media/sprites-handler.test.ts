import { describe, expect, it } from 'vitest';
import { spriteCount } from './sprites-handler.js';

describe('sprite interval planning without decoding media', () => {
  it('does not seek a 19th sheet beyond a 30-minute video when the audio/container has a 7-ms tail', () => {
    expect(
      spriteCount({
        durationMs: 1800007,
        still: false,
        video: { durationFrames: 54000, fps: { num: 30, den: 1 } },
      }),
    ).toBe(1800);
  });
  it('includes an actual fractional final second and keeps rational frame rates', () => {
    expect(
      spriteCount({
        durationMs: 100034,
        still: false,
        video: { durationFrames: 3001, fps: { num: 30, den: 1 } },
      }),
    ).toBe(101);
    expect(
      spriteCount({
        durationMs: 100000,
        still: false,
        video: { durationFrames: 2997, fps: { num: 30000, den: 1001 } },
      }),
    ).toBe(100);
    expect(
      spriteCount({
        durationMs: 100000,
        still: false,
        video: { durationFrames: 2998, fps: { num: 30000, den: 1001 } },
      }),
    ).toBe(101);
  });
  it('keeps a still image at its intended timeline length', () => {
    expect(
      spriteCount({ durationMs: 5000, still: true, video: { durationFrames: 1, fps: { num: 25, den: 1 } } }),
    ).toBe(5);
  });
});
