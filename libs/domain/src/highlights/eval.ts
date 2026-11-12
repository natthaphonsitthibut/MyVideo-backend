/** A labelled highlight (seconds on the source timeline) — see `footage/labels/highlights/*.json`. */
export type HighlightLabel = { startS: number; endS: number; grade: number };
export type PrecisionResult = { k: number; hits: number; precision: number };

/**
 * precision@k for proposed windows (in rank order): a window is a hit when at least `minOverlap` (default 50 %) of
 * its duration lies inside ONE label with `grade >= minGrade`. Fewer than k proposals count as misses (the
 * denominator is always k), so a scorer cannot gain by proposing less.
 */
export function precisionAtK(
  predicted: readonly { startMs: number; endMs: number }[],
  labels: readonly HighlightLabel[],
  k: number,
  minGrade: number,
  minOverlap = 0.5,
): PrecisionResult {
  const relevant = labels.filter((l) => l.grade >= minGrade);
  let hits = 0;
  for (const p of predicted.slice(0, k)) {
    const len = p.endMs - p.startMs;
    if (len <= 0) continue;
    const hit = relevant.some((l) => {
      const overlap = Math.min(p.endMs, l.endS * 1000) - Math.max(p.startMs, l.startS * 1000);
      return overlap / len >= minOverlap;
    });
    if (hit) hits++;
  }
  return { k, hits, precision: hits / k };
}
