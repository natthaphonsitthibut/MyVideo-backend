import type { ClipWordMs } from './clip-project.js';

/**
 * Jump cuts for a clip (pure). Long silences shrink to a short pause and hesitation sounds are removed, so the
 * clip keeps only speech. Silences come from VAD speech spans: ASR word timings are contiguous (a word ends where
 * the next starts), so they cannot show a pause on their own. Everything is in source milliseconds; the result
 * maps any source time onto the shortened output timeline.
 */
export type SpanMs = { startMs: number; endMs: number };
export type CutRules = {
  maxPauseMs: number;
  keepPauseMs: number;
  removeFillers: boolean;
  /** Drop the first take of a phrase the seller says again (`findRestarts`). */
  removeRestarts?: boolean;
};
export type JumpCutPlan = {
  /** Kept source ranges, in order; played back to back. */
  segments: SpanMs[];
  /** Words still spoken in the output (fillers removed), source times unchanged. */
  words: ClipWordMs[];
  durationMs: number;
  /** Source ms → output ms (a time inside a removed range maps to the cut point). */
  toOutputMs: (sourceMs: number) => number;
};

/** A removal shorter than this is not worth a visible jump. */
const MIN_REMOVAL_MS = 120;
/** A kept piece shorter than this between two removals would only flash. */
const MIN_KEEP_MS = 150;

/** Hesitation sounds only. Particles (อ่ะ นะ ค่ะ) and "เออ" (= yes) carry meaning and stay. */
const FILLERS = new Set(['เอ่อ', 'อ่า', 'อืม', 'เอิ่ม', 'อ้า']);
export const isFiller = (text: string) => FILLERS.has(text.trim().replace(/[.…,]+$/u, ''));

const CTA = ['ตะกร้า', 'cf', 'ซีเอฟ', 'สั่งซื้อ', 'สั่งเลย', 'กดสั่ง', 'ทักแชท', 'inbox', 'อินบ็อกซ์', 'ลิงก์', 'กดลิงค์'];

/** Which key moment these words hold: a price ("80 บาท", "฿39", "50%"), a call to action ("กดตะกร้า", "CF"), or none. */
export function keyMomentKind(tokens: readonly string[]): 'price' | 'cta' | null {
  const t = tokens.map((x) => x.trim().toLowerCase());
  const joined = t.join('');
  if (/฿\s*\d|\d\s*%|\d+(?:[.,]\d+)?บาท/u.test(joined)) return 'price';
  if (t.some((x, i) => /^\d/.test(x) && (t[i + 1] ?? '').startsWith('บาท'))) return 'price';
  return CTA.some((c) => joined.includes(c)) ? 'cta' : null;
}

/** A price or a call to action in these words. */
export function isKeyMoment(tokens: readonly string[]): boolean {
  return keyMomentKind(tokens) !== null;
}

/** Particles or hesitations that may sit between two takes of the same phrase ("ไซส์เสียค่ะ ไซส์เสีย"). */
const BETWEEN_TAKES = new Set(['ค่ะ', 'คะ', 'ครับ', 'นะ', 'อ่ะ', 'เอ่อ', 'อ่า', 'อืม', 'เอิ่ม']);
const normToken = (t: string) => t.trim().toLowerCase();

/**
 * Restarts: a phrase (1–4 words) said again right after itself, optionally with one particle between — the first
 * take is dropped, the later (usually cleaner) one stays. A single repeated word counts only if it is long (≥ 4
 * characters): short doubled words ("ดี ดี", "มาก มาก") are Thai emphasis, not a stumble. Returns word ranges
 * (inclusive) to remove; consecutive ones (ASR loops "ตอนนี้ ตอนนี้ ตอนนี้") are merged.
 */
export function findRestarts(
  words: readonly ClipWordMs[],
  maxRun = 4,
  maxSpanMs = 6000,
): { fromWord: number; toWord: number }[] {
  const t = words.map((w) => normToken(w.text));
  const out: { fromWord: number; toWord: number }[] = [];
  let i = 0;
  while (i < t.length) {
    let found: { fromWord: number; toWord: number } | null = null;
    for (let len = Math.min(maxRun, t.length - i); len >= 1 && !found; len--) {
      const run = t.slice(i, i + len).join('|');
      if (len === 1 && (t[i] ?? '').length < 4) continue;
      for (let gap = 0; gap <= 1 && !found; gap++) {
        if (gap === 1 && !BETWEEN_TAKES.has(t[i + len] ?? '')) continue;
        const j = i + len + gap;
        if (j + len > t.length) continue;
        if (t.slice(j, j + len).join('|') !== run) continue;
        const span = (words[j] as ClipWordMs).startMs - (words[i] as ClipWordMs).startMs;
        if (span <= maxSpanMs) found = { fromWord: i, toWord: j - 1 };
      }
    }
    if (found) {
      const last = out[out.length - 1];
      if (last && last.toWord + 1 === found.fromWord) last.toWord = found.toWord;
      else out.push(found);
      i = found.toWord + 1;
    } else i++;
  }
  return out;
}

/** A shot shorter than this after a split would feel like a glitch. */
const MIN_SHOT_MS = 1200;

/**
 * Zoom cuts: split kept segments longer than `maxShotMs` into even pieces at word starts (never mid-word), with
 * no time removed — each piece gets its own framing, so a seller who talks without pauses still gets a lively
 * rhythm. Returns contiguous source ranges.
 */
export function splitLongShots(
  segments: readonly SpanMs[],
  words: readonly ClipWordMs[],
  maxShotMs: number | null,
): SpanMs[] {
  if (!maxShotMs) return segments.map((s) => ({ ...s }));
  const out: SpanMs[] = [];
  for (const s of segments) {
    const len = s.endMs - s.startMs;
    const pieces = Math.ceil(len / maxShotMs);
    if (pieces <= 1) {
      out.push({ ...s });
      continue;
    }
    const starts = words
      .map((w) => w.startMs)
      .filter((t) => t > s.startMs + MIN_SHOT_MS / 2 && t < s.endMs - MIN_SHOT_MS / 2);
    let from = s.startMs;
    for (let k = 1; k < pieces; k++) {
      const ideal = s.startMs + (len * k) / pieces;
      const at = starts
        .filter((t) => t - from >= MIN_SHOT_MS && s.endMs - t >= MIN_SHOT_MS / 2)
        .reduce<number | undefined>(
          (best, t) => (best === undefined || Math.abs(t - ideal) < Math.abs(best - ideal) ? t : best),
          undefined,
        );
      if (at === undefined) continue;
      out.push({ startMs: from, endMs: at });
      from = at;
    }
    out.push({ startMs: from, endMs: s.endMs });
  }
  return out;
}

function subtract(range: SpanMs, removals: SpanMs[]): SpanMs[] {
  const out: SpanMs[] = [];
  let cursor = range.startMs;
  for (const r of removals) {
    if (r.startMs > cursor) out.push({ startMs: cursor, endMs: Math.min(r.startMs, range.endMs) });
    cursor = Math.max(cursor, r.endMs);
  }
  if (cursor < range.endMs) out.push({ startMs: cursor, endMs: range.endMs });
  return out.filter((s) => s.endMs > s.startMs);
}

export function planJumpCuts(
  clip: SpanMs,
  words: readonly ClipWordMs[],
  speech: readonly SpanMs[],
  rules: CutRules,
): JumpCutPlan {
  const removals: SpanMs[] = [];
  const sp = [...speech]
    .filter((s) => s.endMs > clip.startMs && s.startMs < clip.endMs)
    .sort((a, b) => a.startMs - b.startMs);
  for (let i = 0; i + 1 < sp.length; i++) {
    const gapStart = Math.max((sp[i] as SpanMs).endMs, clip.startMs);
    const gapEnd = Math.min((sp[i + 1] as SpanMs).startMs, clip.endMs);
    if (gapEnd - gapStart > rules.maxPauseMs) {
      removals.push({ startMs: gapStart + rules.keepPauseMs / 2, endMs: gapEnd - rules.keepPauseMs / 2 });
    }
  }
  const fillers = new Set<ClipWordMs>();
  if (rules.removeFillers) {
    for (const w of words) {
      if (!isFiller(w.text)) continue;
      fillers.add(w);
      removals.push({ startMs: Math.max(w.startMs, clip.startMs), endMs: Math.min(w.endMs, clip.endMs) });
    }
  }
  if (rules.removeRestarts) {
    for (const r of findRestarts(words)) {
      const first = words[r.fromWord] as ClipWordMs;
      const next = words[r.toWord + 1];
      for (let k = r.fromWord; k <= r.toWord; k++) fillers.add(words[k] as ClipWordMs);
      // up to where the kept take starts, so no sliver of the dropped take is heard
      removals.push({
        startMs: Math.max(first.startMs, clip.startMs),
        endMs: Math.min(next ? next.startMs : (words[r.toWord] as ClipWordMs).endMs, clip.endMs),
      });
    }
  }
  const merged = removals
    .map((r) => ({ startMs: Math.round(r.startMs), endMs: Math.round(r.endMs) }))
    .filter((r) => r.endMs - r.startMs >= MIN_REMOVAL_MS)
    .sort((a, b) => a.startMs - b.startMs)
    .reduce<SpanMs[]>((acc, r) => {
      const last = acc[acc.length - 1];
      // join removals that touch or leave only a flash of picture between them
      if (last && r.startMs - last.endMs < MIN_KEEP_MS) last.endMs = Math.max(last.endMs, r.endMs);
      else acc.push({ ...r });
      return acc;
    }, []);
  let segments = subtract(clip, merged);
  // everything would go (a clip of only hesitation): keep the original range rather than an empty clip
  const fallback = segments.length === 0;
  if (fallback) segments = [{ ...clip }];
  const durationMs = segments.reduce((n, s) => n + s.endMs - s.startMs, 0);
  const toOutputMs = (t: number) => {
    let out = 0;
    for (const s of segments) {
      if (t < s.startMs) return out;
      if (t <= s.endMs) return out + t - s.startMs;
      out += s.endMs - s.startMs;
    }
    return out;
  };
  return {
    segments,
    words: fallback ? [...words] : words.filter((w) => !fillers.has(w)),
    durationMs,
    toOutputMs,
  };
}
