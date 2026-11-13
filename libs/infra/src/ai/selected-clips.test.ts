import { describe, expect, it } from 'vitest';
import { SelectedClipsError, selectedClipWords, validateSelectedRanges } from './selected-clips.js';

describe('manual transcription ranges (pure timing checks, no media)', () => {
  it('keeps disjoint ranges separate and sorts them on the original timeline', () => {
    expect(
      validateSelectedRanges(
        [
          { startMs: 8000, endMs: 9000 },
          { startMs: 1000, endMs: 2000 },
        ],
        10000,
      ),
    ).toEqual([
      { startMs: 1000, endMs: 2000 },
      { startMs: 8000, endMs: 9000 },
    ]);
  });
  it.each(
    [
      [],
      [{ startMs: -1, endMs: 100 }],
      [{ startMs: 2.5, endMs: 100 }],
      [{ startMs: 100, endMs: 100 }],
      [{ startMs: 100, endMs: 11000 }],
      [
        { startMs: 100, endMs: 500 },
        { startMs: 400, endMs: 800 },
      ],
      [
        { startMs: 100, endMs: 500 },
        { startMs: 100, endMs: 500 },
      ],
    ].map((ranges) => ({ ranges })),
  )('rejects invalid or overlapping selections: $ranges', ({ ranges }) => {
    expect(() => validateSelectedRanges(ranges, 10000)).toThrow(SelectedClipsError);
  });
  it('maps local ASR words onto the original source and drops out-of-range words', () => {
    const segments = [
      {
        words: [
          { text: 'ก่อน', start_ms: -100, end_ms: -10 },
          { text: 'คำ', start_ms: 100, end_ms: 400 },
          { text: 'ท้าย', start_ms: 900, end_ms: 1200 },
          { text: 'เกิน', start_ms: 1200, end_ms: 1300 },
        ],
      },
    ];
    expect(selectedClipWords(segments, { startMs: 8000, endMs: 9000 })).toEqual([
      { text: 'คำ', startMs: 8100, endMs: 8400 },
      { text: 'ท้าย', startMs: 8900, endMs: 9000 },
    ]);
  });
});
