import type { SpanMs, TimedSegment } from '../media/chunk-plan.js';

/**
 * Clip boundary snapping and clip rules (E07-F04): pure, deterministic. A proposed clip (word range) is cut only
 * at word boundaries, preferably at a sentence start/end (ASR segment) or inside a VAD silence, and next to a
 * shot cut when there is one; then held to min/max duration; overlapping proposals are merged or dropped and the
 * rest ranked. ASR word timings are contiguous (E04-F03), so the VAD silences are the real pause signal.
 */

export type BoundaryWord = { text: string; startMs: number; endMs: number; segment: number };

export function flattenTranscript(segments: readonly TimedSegment[]): BoundaryWord[] {
  const out: BoundaryWord[] = [];
  segments.forEach((s, segment) => {
    for (const w of s.words) out.push({ text: w.text, startMs: w.startMs, endMs: w.endMs, segment });
  });
  return out;
}

export type BoundaryContext = {
  words: readonly BoundaryWord[];
  /** VAD speech segments (source ms); the gaps between them are silences. */
  speech?: readonly SpanMs[];
  /** Shot cut times (source ms), from scene detection (E07-F05). */
  shotCutsMs?: readonly number[];
  durationMs: number;
};

export type ClipRuleOptions = {
  minMs: number;
  maxMs: number;
  /** How far a boundary may move to reach a cleaner one. */
  maxShiftMs: number;
  /** Lead-in / tail kept around speech, never into a neighbouring word. */
  padMs: number;
  /** A shot cut this close to a boundary is used as the cut point. */
  shotSnapMs: number;
  /** Tolerance when deciding that a word edge touches a VAD silence. */
  silenceTolMs: number;
  /** Two clips overlapping by at least this share of the shorter one are duplicates. */
  duplicateOverlap: number;
  maxClips: number;
};

export const DEFAULT_CLIP_RULES: ClipRuleOptions = {
  minMs: 15_000,
  // short-form sellers' clips: 15–35 s is the target (merchant, 2026-11-13); 40 s leaves room to finish a sentence
  maxMs: 40_000,
  maxShiftMs: 4_000,
  padMs: 200,
  shotSnapMs: 500,
  silenceTolMs: 150,
  duplicateOverlap: 0.5,
  maxClips: 20,
};

export type BoundaryKind = 'sentence' | 'pause' | 'word';

export type ClipProposal = { startWord: number; endWord: number; score: number };

export type SnappedClip<T extends ClipProposal> = T & {
  startMs: number;
  endMs: number;
  boundary: { start: BoundaryKind; end: BoundaryKind; shotAtStart: boolean; shotAtEnd: boolean };
};

type Silence = { startMs: number; endMs: number };

function silences(ctx: BoundaryContext): Silence[] {
  const sp = [...(ctx.speech ?? [])].sort((a, b) => a.startMs - b.startMs);
  const out: Silence[] = [];
  let prev = 0;
  for (const s of sp) {
    if (s.startMs > prev) out.push({ startMs: prev, endMs: s.startMs });
    prev = Math.max(prev, s.endMs);
  }
  if (sp.length > 0 && prev < ctx.durationMs) out.push({ startMs: prev, endMs: ctx.durationMs });
  return out;
}

function inSilence(t: number, sil: readonly Silence[], tol: number): boolean {
  return sil.some((s) => s.startMs - tol <= t && t <= s.endMs + tol);
}

/** Quality of starting at word i: 3 sentence start in a pause, 2 sentence start, 1 pause, 0 any word. */
function startQuality(i: number, ctx: BoundaryContext, sil: readonly Silence[], o: ClipRuleOptions) {
  const w = ctx.words[i] as BoundaryWord;
  const sentence = i === 0 || ctx.words[i - 1]?.segment !== w.segment;
  const pause = i === 0 || inSilence(w.startMs, sil, o.silenceTolMs);
  return (sentence ? 2 : 0) + (pause ? 1 : 0);
}

function endQuality(j: number, ctx: BoundaryContext, sil: readonly Silence[], o: ClipRuleOptions) {
  const w = ctx.words[j] as BoundaryWord;
  const last = j === ctx.words.length - 1;
  const sentence = last || ctx.words[j + 1]?.segment !== w.segment;
  const pause = last || inSilence(w.endMs, sil, o.silenceTolMs);
  return (sentence ? 2 : 0) + (pause ? 1 : 0);
}

const kind = (q: number): BoundaryKind => (q >= 2 ? 'sentence' : q === 1 ? 'pause' : 'word');

/** Cut point before word i: a nearby shot cut in the gap, else lead-in padding, never into word i−1. */
function startCut(i: number, ctx: BoundaryContext, o: ClipRuleOptions): { ms: number; shot: boolean } {
  const w = ctx.words[i] as BoundaryWord;
  const floor = Math.max(0, ctx.words[i - 1]?.endMs ?? 0);
  const shot = (ctx.shotCutsMs ?? [])
    .filter((t) => t >= floor && t <= w.startMs && w.startMs - t <= o.shotSnapMs)
    .sort((a, b) => b - a)[0];
  if (shot !== undefined) return { ms: shot, shot: true };
  return { ms: Math.max(floor, w.startMs - o.padMs), shot: false };
}

function endCut(j: number, ctx: BoundaryContext, o: ClipRuleOptions): { ms: number; shot: boolean } {
  const w = ctx.words[j] as BoundaryWord;
  const ceil = Math.min(ctx.durationMs, ctx.words[j + 1]?.startMs ?? ctx.durationMs);
  const shot = (ctx.shotCutsMs ?? [])
    .filter((t) => t >= w.endMs && t <= ceil && t - w.endMs <= o.shotSnapMs)
    .sort((a, b) => a - b)[0];
  if (shot !== undefined) return { ms: shot, shot: true };
  return { ms: Math.min(ceil, w.endMs + o.padMs), shot: false };
}

function bestNear(
  center: number,
  pick: (i: number) => number,
  quality: (i: number) => number,
  o: ClipRuleOptions,
  bounds: [number, number],
): number {
  const t = pick(center);
  let best = center;
  let bestQ = quality(center);
  let bestD = 0;
  for (let i = bounds[0]; i <= bounds[1]; i++) {
    const d = Math.abs(pick(i) - t);
    if (d > o.maxShiftMs) continue;
    const q = quality(i);
    if (q > bestQ || (q === bestQ && (d < bestD || (d === bestD && i < best)))) {
      best = i;
      bestQ = q;
      bestD = d;
    }
  }
  return best;
}

/** Snaps one proposal; null when no clip of at least `minMs` fits the recording. */
export function snapClip<T extends ClipProposal>(
  proposal: T,
  ctx: BoundaryContext,
  options: Partial<ClipRuleOptions> = {},
): SnappedClip<T> | null {
  const o = { ...DEFAULT_CLIP_RULES, ...options };
  const n = ctx.words.length;
  if (n === 0) return null;
  const sil = silences(ctx);
  const sq = (i: number) => startQuality(i, ctx, sil, o);
  const eq = (j: number) => endQuality(j, ctx, sil, o);
  const clampW = (i: number) => Math.max(0, Math.min(n - 1, i));
  const start0 = clampW(proposal.startWord);
  const end0 = clampW(Math.max(proposal.endWord, start0));

  let s = bestNear(start0, (i) => (ctx.words[i] as BoundaryWord).startMs, sq, o, [0, n - 1]);
  let e = bestNear(end0, (j) => (ctx.words[j] as BoundaryWord).endMs, eq, o, [s, n - 1]);
  const dur = () => endCut(e, ctx, o).ms - startCut(s, ctx, o).ms;

  // too long: end at the cleanest boundary that fits, latest first among equals
  if (dur() > o.maxMs) {
    let pick = -1;
    let pickQ = -1;
    for (let j = s; j < n; j++) {
      e = j;
      const d = dur();
      if (d > o.maxMs) break;
      if (d >= o.minMs && eq(j) >= pickQ) {
        pick = j;
        pickQ = eq(j);
      }
    }
    if (pick < 0) return null;
    e = pick;
  }
  // too short: grow the end over whole sentences first, then the start backwards
  if (dur() < o.minMs) {
    let grown = -1;
    for (let j = e + 1; j < n; j++) {
      e = j;
      if (dur() > o.maxMs) break;
      if (dur() >= o.minMs && eq(j) >= 2) {
        grown = j;
        break;
      }
    }
    if (grown < 0) {
      for (let j = end0; j < n; j++) {
        e = j;
        if (dur() >= o.minMs) {
          grown = j;
          break;
        }
      }
    }
    if (grown < 0) {
      e = n - 1;
      for (let i = s - 1; i >= 0 && dur() < o.minMs; i--) s = i;
    }
    if (dur() < o.minMs || dur() > o.maxMs) return null;
  }

  const a = startCut(s, ctx, o);
  const b = endCut(e, ctx, o);
  return {
    ...proposal,
    startWord: s,
    endWord: e,
    startMs: a.ms,
    endMs: b.ms,
    boundary: { start: kind(sq(s)), end: kind(eq(e)), shotAtStart: a.shot, shotAtEnd: b.shot },
  };
}

export type FinalClip<T extends ClipProposal> = SnappedClip<T> & { rank: number; mergedFrom?: string[] };

const idOf = (c: ClipProposal) => String((c as { id?: unknown }).id ?? '');

/**
 * Snaps every proposal, then best score first: a clip overlapping an accepted one by ≥ `duplicateOverlap` of the
 * shorter is a duplicate (dropped); a smaller overlap is merged into the accepted clip when the union still fits
 * `maxMs`, otherwise dropped. Result: non-overlapping clips ranked 1..n by score, at most `maxClips`.
 */
export function finalizeClips<T extends ClipProposal>(
  proposals: readonly T[],
  ctx: BoundaryContext,
  options: Partial<ClipRuleOptions> = {},
): FinalClip<T>[] {
  const o = { ...DEFAULT_CLIP_RULES, ...options };
  const snapped = proposals
    .map((p) => snapClip(p, ctx, o))
    .filter((c): c is SnappedClip<T> => c !== null)
    .sort((x, y) => y.score - x.score || x.startMs - y.startMs);
  const accepted: FinalClip<T>[] = [];
  for (const c of snapped) {
    const hit = accepted.find((a) => c.startMs < a.endMs && a.startMs < c.endMs);
    if (!hit) {
      accepted.push({ ...c, rank: 0 });
      continue;
    }
    const overlap = Math.min(c.endMs, hit.endMs) - Math.max(c.startMs, hit.startMs);
    const shorter = Math.min(c.endMs - c.startMs, hit.endMs - hit.startMs);
    if (overlap / shorter >= o.duplicateOverlap) continue;
    const startMs = Math.min(c.startMs, hit.startMs);
    const endMs = Math.max(c.endMs, hit.endMs);
    if (endMs - startMs > o.maxMs) continue;
    const others = accepted.filter((a) => a !== hit);
    if (others.some((a) => startMs < a.endMs && a.startMs < endMs)) continue;
    const fromStart = c.startMs < hit.startMs ? c : hit;
    const fromEnd = c.endMs > hit.endMs ? c : hit;
    Object.assign(hit, {
      startWord: fromStart.startWord,
      startMs,
      endWord: fromEnd.endWord,
      endMs,
      boundary: {
        start: fromStart.boundary.start,
        shotAtStart: fromStart.boundary.shotAtStart,
        end: fromEnd.boundary.end,
        shotAtEnd: fromEnd.boundary.shotAtEnd,
      },
      mergedFrom: [...(hit.mergedFrom ?? [idOf(hit)]), idOf(c)],
    });
  }
  return accepted
    .sort((x, y) => y.score - x.score || x.startMs - y.startMs)
    .slice(0, o.maxClips)
    .map((c, i) => ({ ...c, rank: i + 1 }));
}
