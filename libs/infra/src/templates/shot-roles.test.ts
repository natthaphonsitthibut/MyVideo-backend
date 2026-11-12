import { describe, expect, it } from 'vitest';
import { classifyShot, LOW_CONFIDENCE } from './shot-roles.js';

const w = (text: string, startMs: number, endMs: number) => ({ text, startMs, endMs });

describe('shot roles from local signals', () => {
  it('a face on most keyframes + speech = talking head (C03-like: half-body, face ≈ 0.9 % of the frame)', () => {
    const r = classifyShot({
      startMs: 0,
      endMs: 10_000,
      faces: [0.0094, 0.0088, 0],
      words: [w('ตัวนี้', 500, 1_500), w('ดีมาก', 1_500, 3_000), w('ใช้ง่าย', 3_200, 8_000)],
    });
    expect(r.role).toBe('talking_head');
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('no face, short, silent = product close-up; long and silent = demo, but not sure (merchant picks)', () => {
    const close = classifyShot({ startMs: 10_250, endMs: 12_250, faces: [0], words: [] });
    expect(close.role).toBe('product_closeup');
    expect(close.confidence).toBeGreaterThanOrEqual(LOW_CONFIDENCE);
    const long = classifyShot({ startMs: 23_250, endMs: 27_750, faces: [0, 0], words: [] });
    expect(long.role).toBe('demo');
    expect(long.confidence).toBeLessThan(LOW_CONFIDENCE);
  });

  it('the seller says they are opening the box = unboxing, even without a face', () => {
    const r = classifyShot({
      startMs: 0,
      endMs: 6_000,
      faces: [0, 0],
      words: [w('มา', 200, 500), w('แกะ', 500, 900), w('กล่อง', 900, 1_400), w('กัน', 1_400, 1_800)],
    });
    expect(r.role).toBe('unboxing');
  });

  it('no face but a voice over most of a longer shot (C04-like hands + voice-over) = demo', () => {
    const r = classifyShot({
      startMs: 0,
      endMs: 8_000,
      faces: [0, 0, 0],
      words: [w('กด', 300, 2_000), w('ตรงนี้', 2_000, 4_500), w('จะ', 4_500, 5_000), w('วัด', 5_000, 7_500)],
    });
    expect(r.role).toBe('demo');
  });

  it('a face but no speech is a talking head the classifier is unsure about', () => {
    const r = classifyShot({ startMs: 0, endMs: 5_000, faces: [0.01, 0.012], words: [] });
    expect(r.role).toBe('talking_head');
    expect(r.confidence).toBeLessThan(LOW_CONFIDENCE);
  });
});
