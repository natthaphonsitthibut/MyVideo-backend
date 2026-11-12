import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SpanMs, TimedSegment } from '../media/chunk-plan.js';
import { type BoundaryContext, finalizeClips, flattenTranscript, snapClip } from './clip-rules.js';
import { findHighlights } from './scorer.js';

/** Real S01 04:00–08:00: ASR transcript (recipe 2) + real Silero VAD speech segments (fixtures/README.md). */
const fx = JSON.parse(readFileSync(new URL('./fixtures/s01-0400-0800.json', import.meta.url), 'utf8')) as {
  segments: TimedSegment[];
  vad: { speech: SpanMs[] };
  startMs: number;
  endMs: number;
};
const words = flattenTranscript(fx.segments);
const ctx: BoundaryContext = { words, speech: fx.vad.speech, durationMs: fx.endMs };
const OPTS = { minMs: 15_000, maxMs: 60_000 };

/** No cut may fall strictly inside a word. */
const midWord = (t: number) => words.find((w) => w.startMs < t && t < w.endMs);

describe('snapClip on real transcript + VAD', () => {
  // the scorer's windows plus a sweep of arbitrary spans every 7 s (starting and ending anywhere)
  const fromScorer = findHighlights({ segments: fx.segments }, { topN: 8 }).map((c) => ({
    startWord: c.firstWord,
    endWord: c.lastWord,
    score: c.score,
  }));
  const sweep: { startWord: number; endWord: number; score: number }[] = [];
  for (let i = 0; i + 40 < words.length; i += 23)
    sweep.push({ startWord: i, endWord: Math.min(words.length - 1, i + 40 + (i % 90)), score: 1 });
  const inputs = [...fromScorer, ...sweep];

  it('never cuts inside a word, and every clip is within 15–60 s', () => {
    let n = 0;
    for (const input of inputs) {
      const c = snapClip(input, ctx, OPTS);
      if (!c) continue;
      n++;
      expect(midWord(c.startMs)).toBeUndefined();
      expect(midWord(c.endMs)).toBeUndefined();
      expect(c.endMs - c.startMs).toBeGreaterThanOrEqual(15_000);
      expect(c.endMs - c.startMs).toBeLessThanOrEqual(60_000);
      // the cut belongs to the clip's own first/last word: no tail of the previous word, no head of the next
      expect(c.startMs).toBeLessThanOrEqual(words[c.startWord]?.startMs ?? 0);
      expect(c.startMs).toBeGreaterThanOrEqual(words[c.startWord - 1]?.endMs ?? 0);
      expect(c.endMs).toBeGreaterThanOrEqual(words[c.endWord]?.endMs ?? 0);
      expect(c.endMs).toBeLessThanOrEqual(words[c.endWord + 1]?.startMs ?? Number.POSITIVE_INFINITY);
    }
    expect(n).toBeGreaterThan(inputs.length * 0.8);
  });

  it('moves boundaries onto sentence starts/ends or VAD silences when one is near', () => {
    let before = 0;
    let after = 0;
    for (const input of sweep) {
      const c = snapClip(input, ctx, OPTS);
      if (!c) continue;
      if (c.boundary.start !== 'word') after++;
      if (c.boundary.end !== 'word') after++;
      const firstOfSeg =
        input.startWord === 0 || words[input.startWord - 1]?.segment !== words[input.startWord]?.segment;
      const lastOfSeg = words[input.endWord + 1]?.segment !== words[input.endWord]?.segment;
      before += Number(firstOfSeg) + Number(lastOfSeg);
    }
    expect(after).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(sweep.length * 1.5); // most of the 2 boundaries per clip are clean
  });

  it('prefers a shot cut next to the boundary (hand-placed cut, labelled)', () => {
    const input = fromScorer[0] as { startWord: number; endWord: number; score: number };
    const plain = snapClip(input, ctx, OPTS);
    if (!plain) throw new Error('no clip');
    const w = words[plain.startWord] as { startMs: number };
    const prevEnd = words[plain.startWord - 1]?.endMs ?? 0;
    const cut = Math.round((prevEnd + w.startMs) / 2);
    const withCut = snapClip(input, { ...ctx, shotCutsMs: [cut] }, OPTS);
    expect(withCut?.startWord).toBe(plain.startWord);
    expect(withCut?.startMs).toBe(cut);
  });

  it('extends a too-short clip at sentence ends and trims a too-long one', () => {
    const short = snapClip({ startWord: 200, endWord: 205, score: 1 }, ctx, OPTS);
    expect((short?.endMs ?? 0) - (short?.startMs ?? 0)).toBeGreaterThanOrEqual(15_000);
    expect(short?.startWord).toBeLessThanOrEqual(200 + 5);
    const long = snapClip({ startWord: 10, endWord: words.length - 10, score: 1 }, ctx, OPTS);
    expect((long?.endMs ?? 0) - (long?.startMs ?? 0)).toBeLessThanOrEqual(60_000);
    expect(Math.abs((long?.startMs ?? 0) - (words[10]?.startMs ?? 0))).toBeLessThanOrEqual(4_000);
  });

  it('a recording shorter than the minimum gives no clip', () => {
    const tiny = { words: words.slice(0, 10), speech: [], durationMs: words[9]?.endMs ?? 0 };
    expect(snapClip({ startWord: 0, endWord: 5, score: 1 }, tiny, OPTS)).toBeNull();
  });
});

describe('finalizeClips', () => {
  it('merges overlapping proposals, drops near-duplicates and ranks by score', () => {
    const a = { startWord: 100, endWord: 220, score: 9, id: 'a' };
    const dup = { startWord: 105, endWord: 222, score: 5, id: 'dup' };
    const b = { startWord: 500, endWord: 600, score: 7, id: 'b' };
    const out = finalizeClips([b, dup, a], ctx, OPTS);
    expect(out.map((c) => c.id)).toEqual(['a', 'b']);
    expect(out.map((c) => c.rank)).toEqual([1, 2]);
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const x = out[i] as { startMs: number; endMs: number };
        const y = out[j] as { startMs: number; endMs: number };
        expect(x.endMs <= y.startMs || y.endMs <= x.startMs).toBe(true);
      }
    }
  });

  it('a partial overlap whose union fits the maximum becomes one clip', () => {
    const left = { startWord: 100, endWord: 180, score: 6, id: 'l' };
    const right = { startWord: 160, endWord: 240, score: 8, id: 'r' };
    const out = finalizeClips([left, right], ctx, { ...OPTS, maxMs: 90_000 });
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe('r');
    expect(out[0]?.startMs).toBe(snapClip(left, ctx, { ...OPTS, maxMs: 90_000 })?.startMs);
    expect(out[0]?.endMs).toBe(snapClip(right, ctx, { ...OPTS, maxMs: 90_000 })?.endMs);
    expect(out[0]?.mergedFrom).toEqual(['r', 'l']);
  });
});
