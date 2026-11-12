import { describe, expect, it } from 'vitest';
import { clipBuildInput, parseClipBuildInput } from './clip-build-input.js';

// Words/speech shaped like a real S01a clip build (AI-corrected word carries origin + asrText).
const words = [
  { text: 'ตัวนี้', startMs: 287_420, endMs: 287_900 },
  { text: 'พิมพ์', startMs: 287_900, endMs: 288_310, origin: 'ai' as const, asrText: 'พิม' },
  { text: 'ลาย', startMs: 288_310, endMs: 288_700 },
];
const speech = [
  { startMs: 287_400, endMs: 288_750 },
  { startMs: 289_100, endMs: 290_000 },
];

describe('clip build input', () => {
  it('keeps exactly what the builder needs and survives a JSON round trip', () => {
    const input = clipBuildInput({
      plan: {
        startMs: 287_420,
        endMs: 311_740,
        words,
        title: 'Liquid Blue ค่าส่ง 2 ตัวแรก 50 บาท',
        hook: { text: 'ค่าส่ง 2 ตัวแรก 50 บาท', origin: 'ai' },
      },
      speech,
    });
    expect(input).toEqual({
      version: 1,
      startMs: 287_420,
      endMs: 311_740,
      words,
      speech,
      title: 'Liquid Blue ค่าส่ง 2 ตัวแรก 50 บาท',
      hook: { text: 'ค่าส่ง 2 ตัวแรก 50 บาท', origin: 'ai' },
    });
    expect(parseClipBuildInput(JSON.parse(JSON.stringify(input)))).toEqual(input);
  });

  it('a clip without a hook stores null and restores no hook', () => {
    const input = clipBuildInput({ plan: { startMs: 0, endMs: 20_000, words, title: 't' }, speech: [] });
    expect(input.hook).toBeNull();
    expect(parseClipBuildInput(input)?.hook).toBeNull();
  });

  it('rejects missing, old or malformed stored input instead of guessing', () => {
    expect(parseClipBuildInput(null)).toBeNull();
    expect(
      parseClipBuildInput({ version: 2, startMs: 0, endMs: 1, words: [], speech: [], title: '', hook: null }),
    ).toBeNull();
    expect(
      parseClipBuildInput({
        version: 1,
        startMs: 0,
        endMs: 1,
        words: [{ text: 'x' }],
        speech: [],
        title: '',
      }),
    ).toBeNull();
  });
});
