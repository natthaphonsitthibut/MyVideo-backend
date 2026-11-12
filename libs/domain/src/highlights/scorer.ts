import type { TimedSegment } from '../media/chunk-plan.js';
import {
  type LexiconKind,
  type LexiconTerm,
  MEASUREMENT_WORDS,
  THAI_QUESTION_ENDINGS,
  THAI_SELLING_LEXICON,
} from './lexicon.js';

/**
 * Rule-based highlight scorer (E07-F01, ARCHITECTURE §9 "rules" pass): free, deterministic, no network. Slides a
 * window of whole transcript segments over the recording and scores each window from matched selling signals;
 * every score carries the signals that produced it, so the reason is always inspectable.
 */

export type HighlightSignalKind =
  | 'price'
  | LexiconKind
  | 'product'
  | 'question-answered'
  | 'speech-rate'
  | 'loudness'
  | 'complete';

export type HighlightSignal = {
  kind: HighlightSignalKind;
  /** What matched: the transcript text (normalised), the merchant term, or a measured value. */
  term: string;
  /** Source-timeline ms where the signal is (start of the matched word, or of the window for window features). */
  atMs: number;
  segmentIndex?: number;
  /** Index of the matched word inside `segments[segmentIndex].words`. */
  wordIndex?: number;
  /** Strength for graded signals (speech rate, loudness); 1 when absent. */
  amount?: number;
};

/** Loudness per bucket in dBFS (from waveform peaks), starting at `startMs` on the source timeline. */
export type LoudnessTrack = { bucketsPerSecond: number; startMs: number; dbfs: number[] };

export type HighlightInput = { segments: readonly TimedSegment[]; loudness?: LoudnessTrack };

export type HighlightOptions = {
  /** A window grows by whole segments until it is at least this long … */
  windowMs: number;
  /** … but never past this length. */
  maxWindowMs: number;
  /** Windows whose words cover less than this share of their time are scaled down linearly. */
  minCoverage: number;
  /** Merchant-provided product names (matched case-insensitively, spaces ignored). */
  productTerms: string[];
  weights: Record<HighlightSignalKind, number>;
  /** Per-kind cap on the summed amount (so one repeated word cannot dominate). */
  caps: Record<HighlightSignalKind, number>;
  topN: number;
};

export type HighlightCandidate = {
  startMs: number;
  endMs: number;
  firstSegment: number;
  lastSegment: number;
  /** Global word indexes (words of all segments in order), inclusive. */
  firstWord: number;
  lastWord: number;
  score: number;
  /** min(1, speech coverage / minCoverage) — already applied to `score`. */
  coverageFactor: number;
  signals: HighlightSignal[];
  /** Human-readable summary of the signals, strongest first. */
  reason: string;
};

export const DEFAULT_HIGHLIGHT_OPTIONS: HighlightOptions = {
  windowMs: 30_000,
  maxWindowMs: 60_000,
  minCoverage: 0.6,
  productTerms: [],
  weights: {
    price: 3,
    promo: 3,
    urgency: 2.5,
    cta: 2,
    detail: 1,
    // tuned on S01 minutes 0–20 only (agent labels): benefit 1.2 → 2.5 and question-answered 1.5 → 0 raised the
    // tune-split P@5 from 0.40 to 0.80 (held-out 20–45 min unchanged at 0.40). On live selling, spoken questions
    // are mostly chatter ("ไหม", "หรอ"); the signal is still reported, it just does not score. See DECISIONS D-019.
    benefit: 2.5,
    product: 2,
    'question-answered': 0,
    'speech-rate': 1,
    loudness: 1,
    complete: 3,
  },
  caps: {
    price: 3,
    promo: 3,
    urgency: 2,
    cta: 3,
    detail: 5,
    benefit: 3,
    product: 3,
    'question-answered': 2,
    'speech-rate': 2,
    loudness: 2,
    complete: 1,
  },
  topN: 10,
};

const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
const QUESTION_ANSWER_GAP_MS = 8_000;

type Prepared = {
  seg: TimedSegment;
  signals: HighlightSignal[];
  hasNumber: boolean;
  isQuestion: boolean;
  speechMs: number;
};

/** Finds lexicon/price/product matches in one segment (word-anchored). */
function matchSegment(seg: TimedSegment, index: number, productTerms: readonly string[]): Prepared {
  const words = seg.words.map((w) => norm(w.text));
  const starts: number[] = [];
  let hay = '';
  for (const w of words) {
    starts.push(hay.length);
    hay += w;
  }
  const wordAt = (pos: number) => {
    let i = 0;
    while (i + 1 < starts.length && (starts[i + 1] ?? Infinity) <= pos) i++;
    return i;
  };
  const signals: HighlightSignal[] = [];
  const add = (kind: HighlightSignalKind, term: string, pos: number) => {
    const wi = wordAt(pos);
    signals.push({
      kind,
      term,
      atMs: seg.words[wi]?.startMs ?? seg.startMs,
      segmentIndex: index,
      wordIndex: wi,
    });
  };

  // lexicon: longest terms first; a kind never counts the same characters twice
  for (const [kind, terms] of Object.entries(THAI_SELLING_LEXICON) as [LexiconKind, LexiconTerm[]][]) {
    const taken: [number, number][] = [];
    const free = (a: number, b: number) => taken.every(([x, y]) => b <= x || a >= y);
    for (const t of [...terms].sort((a, b) => b.term.length - a.term.length)) {
      const term = norm(t.term);
      if (t.whole) {
        words.forEach((w, wi) => {
          const a = starts[wi] ?? 0;
          if (w === term && free(a, a + w.length)) {
            taken.push([a, a + w.length]);
            add(kind, t.term, a);
          }
        });
        continue;
      }
      for (let p = hay.indexOf(term); p !== -1; p = hay.indexOf(term, p + term.length)) {
        if (!free(p, p + term.length)) continue;
        taken.push([p, p + term.length]);
        add(kind, t.term, p);
      }
    }
  }

  // prices: "<number> บาท", "฿<number>", "ราคา" — but "ยาว 27 บาท" is a body measurement the ASR misheard
  for (const m of hay.matchAll(/(\d[\d,]*(?:\.\d+)?)บาท/g)) {
    const p = m.index ?? 0;
    const before = hay.slice(Math.max(0, p - 4), p);
    if (MEASUREMENT_WORDS.some((mw) => before.endsWith(mw))) continue;
    add('price', `${m[1]} บาท`, p);
  }
  for (const m of hay.matchAll(/฿\d[\d,]*/g)) add('price', m[0], m.index ?? 0);
  for (let p = hay.indexOf('ราคา'); p !== -1; p = hay.indexOf('ราคา', p + 4)) add('price', 'ราคา', p);

  for (const name of productTerms) {
    const term = norm(name);
    if (term.length === 0) continue;
    for (let p = hay.indexOf(term); p !== -1; p = hay.indexOf(term, p + term.length)) add('product', name, p);
  }

  const last = words[words.length - 1] ?? '';
  const isQuestion = seg.text.trim().endsWith('?') || THAI_QUESTION_ENDINGS.some((q) => last.endsWith(q));
  const speechMs = seg.words.reduce((sum, w) => sum + Math.max(0, w.endMs - w.startMs), 0);
  return { seg, signals, hasNumber: /\d/.test(hay), isQuestion, speechMs };
}

function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
}

function meanLoudness(track: LoudnessTrack | undefined, startMs: number, endMs: number): number | undefined {
  if (!track) return undefined;
  const per = 1000 / track.bucketsPerSecond;
  const a = Math.max(0, Math.floor((startMs - track.startMs) / per));
  const b = Math.min(track.dbfs.length, Math.ceil((endMs - track.startMs) / per));
  let sum = 0;
  let n = 0;
  for (let i = a; i < b; i++) {
    const v = track.dbfs[i] ?? -90;
    if (v > -50) {
      sum += v;
      n++;
    }
  }
  return n === 0 ? undefined : sum / n;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

function describe(signals: HighlightSignal[], opts: HighlightOptions): string {
  const by = new Map<HighlightSignalKind, HighlightSignal[]>();
  for (const s of signals) by.set(s.kind, [...(by.get(s.kind) ?? []), s]);
  const parts = [...by.entries()].map(([kind, list]) => {
    const amount = list.reduce((a, s) => a + (s.amount ?? 1), 0);
    const contribution = opts.weights[kind] * Math.min(amount, opts.caps[kind]);
    const terms = [...new Set(list.map((s) => s.term))].slice(0, 3).join(', ');
    return { contribution, text: `${kind} ×${list.length} (${terms})` };
  });
  return parts
    .sort((a, b) => b.contribution - a.contribution)
    .map((p) => p.text)
    .join(' · ');
}

/** Scores every window (one per starting segment), in timeline order. */
export function scoreWindows(
  input: HighlightInput,
  options: Partial<HighlightOptions> = {},
): HighlightCandidate[] {
  const opts: HighlightOptions = { ...DEFAULT_HIGHLIGHT_OPTIONS, ...options };
  const segs = input.segments;
  const prepared = segs.map((s, i) => matchSegment(s, i, opts.productTerms));

  // a question followed shortly by an answer with a number/price ("เท่าไหร่" → "150 บาท")
  const answered = new Map<number, HighlightSignal>();
  prepared.forEach((p, i) => {
    if (!p.isQuestion) return;
    for (let j = i + 1; j < Math.min(segs.length, i + 4); j++) {
      const a = prepared[j] as Prepared;
      if (a.seg.startMs - p.seg.endMs > QUESTION_ANSWER_GAP_MS) break;
      if (a.hasNumber && !answered.has(j)) {
        answered.set(j, {
          kind: 'question-answered',
          term: p.seg.text.trim().slice(0, 40),
          atMs: a.seg.startMs,
          segmentIndex: j,
        });
        break;
      }
    }
  });

  const wordBase: number[] = [];
  let total = 0;
  for (const s of segs) {
    wordBase.push(total);
    total += s.words.length;
  }

  type Raw = { i: number; j: number; wps: number; db: number | undefined; coverage: number };
  const raws: Raw[] = [];
  for (let i = 0; i < segs.length; i++) {
    const start = (segs[i] as TimedSegment).startMs;
    let j = i;
    while (
      j + 1 < segs.length &&
      (segs[j] as TimedSegment).endMs - start < opts.windowMs &&
      (segs[j + 1] as TimedSegment).endMs - start <= opts.maxWindowMs
    ) {
      j++;
    }
    const end = (segs[j] as TimedSegment).endMs;
    const dur = Math.max(1, end - start);
    let words = 0;
    let speech = 0;
    for (let k = i; k <= j; k++) {
      words += (segs[k] as TimedSegment).words.length;
      speech += (prepared[k] as Prepared).speechMs;
    }
    raws.push({
      i,
      j,
      wps: words / (dur / 1000),
      db: meanLoudness(input.loudness, start, end),
      coverage: speech / dur,
    });
  }
  const medWps = median(raws.map((r) => r.wps));
  const medDb = median(raws.flatMap((r) => (r.db === undefined ? [] : [r.db])));

  return raws.map(({ i, j, wps, db, coverage }) => {
    const startMs = (segs[i] as TimedSegment).startMs;
    const endMs = (segs[j] as TimedSegment).endMs;
    const signals: HighlightSignal[] = [];
    for (let k = i; k <= j; k++) {
      signals.push(...(prepared[k] as Prepared).signals);
      const qa = answered.get(k);
      if (qa) signals.push(qa);
    }
    if (medWps && medWps > 0) {
      const ratio = wps / medWps;
      if (ratio >= 1.15) {
        const amount = round2(Math.min(2, (ratio - 1) / 0.25));
        signals.push({ kind: 'speech-rate', term: `${round2(ratio)}× median rate`, atMs: startMs, amount });
      }
    }
    if (db !== undefined && medDb !== undefined && db - medDb >= 1.5) {
      const amount = round2(Math.min(2, (db - medDb) / 3));
      signals.push({ kind: 'loudness', term: `+${round2(db - medDb)} dB vs median`, atMs: startMs, amount });
    }
    const kinds = new Set(signals.map((s) => s.kind));
    const parts = ['price', 'cta', 'detail'].filter((k) => kinds.has(k as HighlightSignalKind)).length;
    if (parts + (kinds.has('benefit') || kinds.has('promo') ? 1 : 0) >= 3) {
      signals.push({ kind: 'complete', term: 'price/cta/detail/benefit', atMs: startMs });
    }

    const amounts = new Map<HighlightSignalKind, number>();
    for (const s of signals) amounts.set(s.kind, (amounts.get(s.kind) ?? 0) + (s.amount ?? 1));
    let raw = 0;
    for (const [kind, n] of amounts) raw += opts.weights[kind] * Math.min(n, opts.caps[kind]);
    const coverageFactor = Math.min(1, coverage / opts.minCoverage);

    return {
      startMs,
      endMs,
      firstSegment: i,
      lastSegment: j,
      firstWord: wordBase[i] ?? 0,
      lastWord: (wordBase[j] ?? 0) + (segs[j] as TimedSegment).words.length - 1,
      score: raw * coverageFactor,
      coverageFactor,
      signals,
      reason: describe(signals, opts),
    };
  });
}

/** Greedy: best score first (ties → earlier), skipping any window that overlaps one already picked. */
export function pickTopCandidates(
  candidates: readonly HighlightCandidate[],
  n: number,
): HighlightCandidate[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score || a.startMs - b.startMs);
  const picked: HighlightCandidate[] = [];
  for (const c of sorted) {
    if (picked.length >= n) break;
    if (picked.some((p) => c.startMs < p.endMs && p.startMs < c.endMs)) continue;
    picked.push(c);
  }
  return picked;
}

/** The rules-mode answer: the top non-overlapping windows. */
export function findHighlights(
  input: HighlightInput,
  options: Partial<HighlightOptions> = {},
): HighlightCandidate[] {
  const opts = { ...DEFAULT_HIGHLIGHT_OPTIONS, ...options };
  return pickTopCandidates(scoreWindows(input, opts), opts.topN);
}
