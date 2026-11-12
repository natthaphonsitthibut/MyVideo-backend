import { describe, expect, it } from 'vitest';
import { PeaksBuilder } from './peaks.js';

const tone = (n: number, amp: number) =>
  Int16Array.from({ length: n }, (_, i) => Math.round(Math.sin(i / 3) * amp));

describe('PeaksBuilder', () => {
  it('makes 100 buckets per second at level 0 and coarser levels by 4×', () => {
    const b = new PeaksBuilder(8000);
    b.push(tone(8000 * 3, 16000)); // 3 s
    const p = b.finish(3000);
    expect(p.levels.map((l) => l.bucketsPerSecond)).toEqual([100, 25, 6.25, 1.5625]);
    expect(p.levels[0]?.min).toHaveLength(300);
    expect(p.levels[1]?.max).toHaveLength(75);
    expect(p.levels[3]?.max).toHaveLength(Math.ceil(300 / 64));
    expect(p.silent).toBe(false);
    expect(Math.max(...(p.levels[0]?.max ?? []))).toBeGreaterThan(55); // ~16000/32768 * 127
    expect(Math.min(...(p.levels[0]?.min ?? []))).toBeLessThan(-55);
  });

  it('accepts sample chunks split at any point (streaming) and gives the same result', () => {
    const all = tone(12_345, 9000);
    const one = new PeaksBuilder(8000);
    one.push(all);
    const many = new PeaksBuilder(8000);
    for (let i = 0; i < all.length; i += 777) many.push(all.subarray(i, i + 777));
    expect(many.finish(1543)).toEqual(one.finish(1543));
  });

  it('decodes little-endian PCM bytes with odd chunk boundaries', () => {
    const samples = tone(1000, 20000);
    const bytes = Buffer.from(samples.buffer);
    const b = new PeaksBuilder(8000);
    for (let i = 0; i < bytes.length; i += 333) b.pushBytes(bytes.subarray(i, i + 333));
    const ref = new PeaksBuilder(8000);
    ref.push(samples);
    expect(b.finish(125)).toEqual(ref.finish(125));
  });

  it('flags near-silence', () => {
    const b = new PeaksBuilder(8000);
    b.push(tone(8000, 40)); // ≈ -58 dBFS
    expect(b.finish(1000).silent).toBe(true);
  });

  it('pads the bucket count to the real duration', () => {
    const b = new PeaksBuilder(8000);
    b.push(tone(4000, 1000)); // 0.5 s of samples, file says 0.52 s
    expect(b.finish(520).levels[0]?.max).toHaveLength(52);
  });
});
