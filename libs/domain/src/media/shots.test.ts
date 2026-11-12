import { describe, expect, it } from 'vitest';
import { mergeShotParts, planShotParts } from './shots.js';

describe('planShotParts', () => {
  it('splits a long recording into contiguous parts of at most partMs', () => {
    const parts = planShotParts(2_700_000, 300_000); // 45 min in 5-min parts
    expect(parts).toHaveLength(9);
    expect(parts[0]).toEqual({ index: 0, startMs: 0, endMs: 300_000 });
    expect(parts.at(-1)).toEqual({ index: 8, startMs: 2_400_000, endMs: 2_700_000 });
    for (let i = 1; i < parts.length; i++) expect(parts[i]?.startMs).toBe(parts[i - 1]?.endMs);
  });

  it('a short file is one part; a tiny tail is folded into the previous part', () => {
    expect(planShotParts(55_000, 300_000)).toEqual([{ index: 0, startMs: 0, endMs: 55_000 }]);
    const p = planShotParts(305_000, 300_000);
    expect(p).toEqual([{ index: 0, startMs: 0, endMs: 305_000 }]);
  });
});

describe('mergeShotParts', () => {
  // hand-made shot lists (labelled): the part border at 20 s is not a cut
  it('joins the shot that crosses a part border and keeps real cuts', () => {
    const merged = mergeShotParts([
      {
        startMs: 0,
        endMs: 20_000,
        shots: [
          { startMs: 0, endMs: 8_000, keyframes: ['a'] },
          { startMs: 8_000, endMs: 20_000, keyframes: ['b'] },
        ],
      },
      {
        startMs: 20_000,
        endMs: 40_000,
        shots: [
          { startMs: 20_000, endMs: 31_000, keyframes: ['c'] },
          { startMs: 31_000, endMs: 40_000, keyframes: ['d'] },
        ],
      },
    ]);
    expect(merged.map((s) => [s.startMs, s.endMs])).toEqual([
      [0, 8_000],
      [8_000, 31_000],
      [31_000, 40_000],
    ]);
    expect(merged[1]?.keyframes).toEqual(['b', 'c']);
  });

  it('a real cut right at the part border survives', () => {
    const merged = mergeShotParts([
      { startMs: 0, endMs: 20_000, shots: [{ startMs: 0, endMs: 20_000, keyframes: [] }] },
      {
        startMs: 20_000,
        endMs: 40_000,
        cutAtStart: true,
        shots: [{ startMs: 20_000, endMs: 40_000, keyframes: [] }],
      },
    ]);
    expect(merged).toHaveLength(2);
  });
});
