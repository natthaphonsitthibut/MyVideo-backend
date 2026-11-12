import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimedSegment } from '../media/chunk-plan.js';
import { precisionAtK } from './eval.js';
import {
  DEFAULT_HIGHLIGHT_OPTIONS,
  findHighlights,
  type HighlightCandidate,
  type LoudnessTrack,
  pickTopCandidates,
  scoreWindows,
} from './scorer.js';

/** Real S01 excerpt 04:00–08:00 (ASR recipe 2 + peaks), see fixtures/README.md. */
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/s01-0400-0800.json', import.meta.url), 'utf8'),
) as {
  segments: TimedSegment[];
  loudness: LoudnessTrack;
};
const input = { segments: fixture.segments, loudness: fixture.loudness };

afterEach(() => vi.unstubAllGlobals());

describe('scoreWindows on a real live-selling excerpt', () => {
  const windows = scoreWindows(input);

  it('covers the excerpt with windows of the configured length, each a run of whole segments', () => {
    expect(windows.length).toBeGreaterThan(20);
    for (const w of windows) {
      const first = fixture.segments[w.firstSegment];
      const last = fixture.segments[w.lastSegment];
      expect(w.startMs).toBe(first?.startMs);
      expect(w.endMs).toBe(last?.endMs);
      expect(w.endMs - w.startMs).toBeLessThanOrEqual(DEFAULT_HIGHLIGHT_OPTIONS.maxWindowMs);
    }
  });

  it('every signal points at the real word it matched, inside the window', () => {
    let checked = 0;
    for (const w of windows) {
      for (const s of w.signals) {
        expect(s.atMs).toBeGreaterThanOrEqual(w.startMs);
        expect(s.atMs).toBeLessThanOrEqual(w.endMs);
        if (s.segmentIndex === undefined || s.wordIndex === undefined) continue;
        const seg = fixture.segments[s.segmentIndex];
        const word = seg?.words[s.wordIndex];
        expect(word?.startMs).toBe(s.atMs);
        // the matched text really is in the segment's words, starting inside that word
        const norm = (x: string) => x.replace(/\s+/g, '').toLowerCase();
        const from = norm(
          (seg?.words ?? [])
            .slice(s.wordIndex)
            .map((x) => x.text)
            .join(''),
        );
        const at = from.indexOf(norm(s.term));
        expect(at).toBeGreaterThanOrEqual(0);
        expect(at).toBeLessThan(norm(word?.text ?? '').length);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('finds the price and ordering language the seller really said', () => {
    // 05:00 "200 บาทค่ะ ค่าจะส่ง 2 ตัวแรก 50 บาท ตัวตัวไปตัวละ 10 บาทนะคะ"
    const at5 = windows.find((w) => w.startMs <= 300_000 && w.endMs >= 305_000);
    expect(at5).toBeDefined();
    const terms = at5?.signals.filter((s) => s.kind === 'price').map((s) => s.term);
    expect(terms).toContain('200 บาท');
    expect(terms).toContain('50 บาท');
    expect(at5?.signals.some((s) => s.kind === 'cta')).toBe(true);
  });

  it('a body measurement read as "ยาว 27 บาท" by the ASR is a size detail, not a price', () => {
    // real S01 ASR lines (25:59 and 22:25), word split as the tokenizer does; timings hand-made (labelled)
    const seg = (startMs: number, texts: string[]) => ({
      startMs,
      endMs: startMs + texts.length * 300,
      text: texts.join(' '),
      words: texts.map((text, i) => ({
        text,
        kind: 'th',
        startMs: startMs + i * 300,
        endMs: startMs + i * 300 + 300,
      })),
    });
    const w = scoreWindows({
      segments: [
        seg(0, ['ออก', '25.5', 'ยาว', '27', 'บาท', 'ค่ะ', '80', 'บาท', 'ค่ะ']),
        seg(5000, ['ออก', '23.5', 'ยาว', '28.5', 'หรือ', '250', 'บาท', 'ค่ะ']),
      ],
    });
    const prices = w[0]?.signals.filter((s) => s.kind === 'price').map((s) => s.term);
    expect(prices).toEqual(['80 บาท', '250 บาท']);
    expect(w[0]?.signals.filter((s) => s.kind === 'detail').map((s) => s.term)).toEqual(['ยาว', 'ยาว']);
  });

  it('the score is exactly the weighted sum of its (capped) signal counts times speech coverage', () => {
    const o = DEFAULT_HIGHLIGHT_OPTIONS;
    for (const w of windows.slice(0, 15)) {
      const counts = new Map<string, number>();
      for (const s of w.signals) counts.set(s.kind, (counts.get(s.kind) ?? 0) + (s.amount ?? 1));
      let raw = 0;
      for (const [k, n] of counts) {
        const kind = k as keyof typeof o.weights;
        raw += o.weights[kind] * Math.min(n, o.caps[kind]);
      }
      expect(w.score).toBeCloseTo(raw * w.coverageFactor, 6);
      expect(w.reason.length).toBeGreaterThan(0);
    }
  });

  it('the best window has price + call-to-action; the weakest has no price at all', () => {
    const sorted = [...windows].sort((a, b) => b.score - a.score);
    const best = sorted[0] as HighlightCandidate;
    const worst = sorted[sorted.length - 1] as HighlightCandidate;
    expect(best.signals.some((s) => s.kind === 'price')).toBe(true);
    expect(best.signals.some((s) => s.kind === 'cta')).toBe(true);
    expect(worst.signals.some((s) => s.kind === 'price')).toBe(false);
    expect(best.reason).toMatch(/price/);
  });

  it('merchant product names become signals only when given', () => {
    const without = scoreWindows(input).flatMap((w) => w.signals);
    expect(without.some((s) => s.kind === 'product')).toBe(false);
    const withNames = scoreWindows(input, { productTerms: ['OPPA', 'Starbuck'] }).flatMap((w) => w.signals);
    const products = withNames.filter((s) => s.kind === 'product');
    expect(products.length).toBeGreaterThan(0);
    for (const p of products) expect(p.atMs).toBeGreaterThanOrEqual(360_000); // said at 06:00+
  });

  it('weights are configurable: a zero price weight removes price from the score', () => {
    const noPrice = scoreWindows(input, {
      weights: { ...DEFAULT_HIGHLIGHT_OPTIONS.weights, price: 0 },
    });
    const at5 = windows.find((w) => w.startMs <= 300_000 && w.endMs >= 305_000) as HighlightCandidate;
    const at5b = noPrice.find((w) => w.startMs === at5.startMs) as HighlightCandidate;
    expect(at5b.score).toBeLessThan(at5.score);
  });

  it('runs with zero network calls and is deterministic', () => {
    const boom = vi.fn(() => {
      throw new Error('network call');
    });
    vi.stubGlobal('fetch', boom);
    const a = findHighlights(input, { topN: 5 });
    const b = findHighlights(input, { topN: 5 });
    expect(boom).not.toHaveBeenCalled();
    expect(a).toEqual(b);
    expect(a).toHaveLength(5);
  });
});

describe('speech rate and loudness', () => {
  // hand-made timings (labelled): 3 windows of 10 s; the middle one is spoken twice as fast and 6 dB louder
  const mk = (start: number, n: number) => ({
    startMs: start,
    endMs: start + 10_000,
    text: 'ก'.repeat(n),
    words: Array.from({ length: n }, (_, i) => ({
      text: 'ก',
      kind: 'th',
      startMs: start + Math.floor((i * 10_000) / n),
      endMs: start + Math.floor(((i + 1) * 10_000) / n),
    })),
  });
  const segments = [mk(0, 20), mk(10_000, 40), mk(20_000, 20)];
  const dbfs = [...Array(100).fill(-20), ...Array(100).fill(-14), ...Array(100).fill(-20)];
  const opts = { windowMs: 10_000, maxWindowMs: 10_000 };

  it('flags the faster and louder window with amounts relative to the recording', () => {
    const w = scoreWindows({ segments, loudness: { bucketsPerSecond: 10, startMs: 0, dbfs } }, opts);
    expect(w).toHaveLength(3);
    const mid = w[1] as HighlightCandidate;
    expect(mid.signals.find((s) => s.kind === 'speech-rate')?.amount).toBeGreaterThan(0);
    expect(mid.signals.find((s) => s.kind === 'loudness')?.amount).toBeGreaterThan(0);
    expect(w[0]?.signals.some((s) => s.kind === 'speech-rate' || s.kind === 'loudness')).toBe(false);
  });

  it('works without loudness data (no audio features → no loudness signal)', () => {
    const w = scoreWindows({ segments }, opts);
    expect(w.flatMap((x) => x.signals).some((s) => s.kind === 'loudness')).toBe(false);
  });
});

describe('pickTopCandidates', () => {
  const c = (startMs: number, endMs: number, score: number) =>
    ({ startMs, endMs, score, signals: [], reason: '' }) as unknown as HighlightCandidate;

  it('takes the best first and drops anything overlapping a pick', () => {
    const picked = pickTopCandidates([c(0, 30, 5), c(20, 50, 9), c(50, 80, 4), c(60, 90, 7)], 3);
    expect(picked.map((p) => [p.startMs, p.score])).toEqual([
      [20, 9],
      [60, 7],
    ]);
  });
});

describe('precisionAtK', () => {
  // hand-made numbers (labelled)
  const labels = [
    { startS: 10, endS: 40, grade: 2 },
    { startS: 100, endS: 130, grade: 1 },
  ];
  it('counts a hit when ≥ 50 % of the window lies in one label of at least the grade', () => {
    const preds = [
      { startMs: 15_000, endMs: 45_000 }, // 25/30 in label 1 → hit
      { startMs: 120_000, endMs: 150_000 }, // 10/30 → miss
      { startMs: 100_000, endMs: 125_000 }, // grade 1 → hit at minGrade 1, miss at 2
    ];
    expect(precisionAtK(preds, labels, 3, 1)).toEqual({ k: 3, hits: 2, precision: 2 / 3 });
    expect(precisionAtK(preds, labels, 3, 2)).toEqual({ k: 3, hits: 1, precision: 1 / 3 });
    expect(precisionAtK(preds, labels, 5, 1)).toEqual({ k: 5, hits: 2, precision: 2 / 5 });
  });
});
