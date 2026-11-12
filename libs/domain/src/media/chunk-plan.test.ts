import { describe, expect, it } from 'vitest';
import { offsetChunkSegments, planChunks } from './chunk-plan.js';

const MIN = 60_000;

describe('planChunks', () => {
  it('no speech → no chunks', () => {
    expect(planChunks([], 120_000)).toEqual([]);
  });

  it('short file → one chunk covering the whole file', () => {
    expect(
      planChunks(
        [
          { startMs: 1000, endMs: 5000 },
          { startMs: 8000, endMs: 20_000 },
        ],
        30_000,
      ),
    ).toEqual([{ index: 0, startMs: 0, endMs: 30_000 }]);
  });

  it('long file → contiguous chunks ≤ max, cut in the middle of a silence', () => {
    // speech 0–4 min, 4:10–8 min, 8:20–12 min, 12:02–15 min
    const speech = [
      { startMs: 0, endMs: 4 * MIN },
      { startMs: 4 * MIN + 10_000, endMs: 8 * MIN },
      { startMs: 8 * MIN + 20_000, endMs: 12 * MIN },
      { startMs: 12 * MIN + 2000, endMs: 15 * MIN },
    ];
    const chunks = planChunks(speech, 15 * MIN, { maxMs: 10 * MIN });
    expect(chunks).toEqual([
      { index: 0, startMs: 0, endMs: 8 * MIN + 10_000 },
      { index: 1, startMs: 8 * MIN + 10_000, endMs: 15 * MIN },
    ]);
    // the cut never lands inside a speech segment
    for (const c of chunks.slice(1)) {
      expect(speech.some((s) => s.startMs < c.startMs && c.startMs < s.endMs)).toBe(false);
    }
  });

  it('every chunk ≤ max, chunks are contiguous and cover all speech', () => {
    const speech = Array.from({ length: 200 }, (_, i) => ({
      startMs: i * 15_000 + 500,
      endMs: i * 15_000 + 13_000,
    }));
    const duration = 200 * 15_000;
    const chunks = planChunks(speech, duration, { maxMs: 10 * MIN });
    expect(chunks[0]?.startMs).toBe(0);
    // last speech ends at 2 998 000; trailing silence may be cut off when it would exceed max
    expect(chunks.at(-1)?.endMs).toBeGreaterThanOrEqual(2_998_000);
    expect(chunks.at(-1)?.endMs).toBeLessThanOrEqual(duration);
    for (const [i, c] of chunks.entries()) {
      expect(c.index).toBe(i);
      expect(c.endMs - c.startMs).toBeLessThanOrEqual(10 * MIN);
      expect(c.endMs).toBeGreaterThan(c.startMs);
      if (i > 0) expect(c.startMs).toBe(chunks[i - 1]?.endMs);
    }
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    expect(chunks.length).toBeLessThanOrEqual(6);
  });

  it('one speech run longer than max is hard-cut at max', () => {
    const chunks = planChunks([{ startMs: 0, endMs: 25 * MIN }], 25 * MIN, { maxMs: 10 * MIN });
    expect(chunks.map((c) => [c.startMs, c.endMs])).toEqual([
      [0, 10 * MIN],
      [10 * MIN, 20 * MIN],
      [20 * MIN, 25 * MIN],
    ]);
  });

  it('a long silence stretch with no speech is skipped (no chunk without speech)', () => {
    const speech = [
      { startMs: 0, endMs: 2 * MIN },
      { startMs: 30 * MIN, endMs: 31 * MIN },
    ];
    const chunks = planChunks(speech, 32 * MIN, { maxMs: 10 * MIN });
    for (const c of chunks) {
      expect(speech.some((s) => s.startMs < c.endMs && s.endMs > c.startMs)).toBe(true);
    }
    expect(chunks.at(-1)?.endMs).toBe(32 * MIN);
    expect(chunks[0]?.startMs).toBe(0);
  });

  it('ignores segments outside the file and unsorted input', () => {
    const chunks = planChunks(
      [
        { startMs: 20_000, endMs: 25_000 },
        { startMs: 1000, endMs: 3000 },
        { startMs: 50_000, endMs: 60_000 },
      ],
      30_000,
    );
    expect(chunks).toEqual([{ index: 0, startMs: 0, endMs: 30_000 }]);
  });
});

describe('offsetChunkSegments', () => {
  it('moves chunk-relative times onto the source timeline and clamps to the chunk', () => {
    const out = offsetChunkSegments(
      [
        {
          startMs: 0,
          endMs: 2000,
          text: 'ราคา 100 บาท',
          words: [
            { text: 'ราคา', startMs: 0, endMs: 800, kind: 'word' },
            { text: '100 บาท', startMs: 800, endMs: 2000, kind: 'number' },
          ],
        },
        {
          startMs: 59_000,
          endMs: 61_000,
          text: 'ค่ะ',
          words: [{ text: 'ค่ะ', startMs: 59_000, endMs: 61_000, kind: 'word' }],
        },
      ],
      { index: 1, startMs: 600_000, endMs: 660_000 },
    );
    expect(out[0]).toMatchObject({ startMs: 600_000, endMs: 602_000 });
    expect(out[0]?.words[1]).toMatchObject({ startMs: 600_800, endMs: 602_000 });
    expect(out[1]).toMatchObject({ startMs: 659_000, endMs: 660_000 });
    expect(out[1]?.words[0]).toMatchObject({ startMs: 659_000, endMs: 660_000 });
  });

  it('drops segments that start after the chunk end', () => {
    const out = offsetChunkSegments([{ startMs: 70_000, endMs: 71_000, text: 'x', words: [] }], {
      index: 0,
      startMs: 0,
      endMs: 60_000,
    });
    expect(out).toEqual([]);
  });
});
