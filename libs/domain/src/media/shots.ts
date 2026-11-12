/**
 * Shot detection over long recordings (E07-F05): the file is analysed part by part (visible progress, resume after
 * a crash), then the parts' shot lists are joined. A part border is not a cut, so the shot that crosses it is one
 * shot — unless the detector saw a real cut exactly there (`cutAtStart`).
 */

/** Recipe of shot detection (detectors + thresholds + keyframe layout); bump when the output would change. */
export const SHOTS_RECIPE = 1;
/** Default part length for long files. */
export const SHOT_PART_MS = 5 * 60_000;

export type ShotPartSpan = { index: number; startMs: number; endMs: number };

export function planShotParts(durationMs: number, partMs = SHOT_PART_MS): ShotPartSpan[] {
  const parts: ShotPartSpan[] = [];
  for (let s = 0; s < durationMs; s += partMs) {
    parts.push({ index: parts.length, startMs: s, endMs: Math.min(durationMs, s + partMs) });
  }
  // fold a tail shorter than 10 % of a part into the previous one
  const last = parts.at(-1);
  const prev = parts.at(-2);
  if (last && prev && last.endMs - last.startMs < partMs * 0.1) {
    prev.endMs = last.endMs;
    parts.pop();
  }
  return parts;
}

export type DetectedShot<K> = { startMs: number; endMs: number; keyframes: K[] };
export type ShotPartResult<K> = {
  startMs: number;
  endMs: number;
  cutAtStart?: boolean;
  shots: DetectedShot<K>[];
};

export function mergeShotParts<K>(parts: readonly ShotPartResult<K>[]): DetectedShot<K>[] {
  const out: DetectedShot<K>[] = [];
  for (const part of [...parts].sort((a, b) => a.startMs - b.startMs)) {
    part.shots.forEach((shot, i) => {
      const prev = out.at(-1);
      if (i === 0 && prev && !part.cutAtStart && prev.endMs === shot.startMs) {
        prev.endMs = shot.endMs;
        prev.keyframes = [...prev.keyframes, ...shot.keyframes];
      } else {
        out.push({ startMs: shot.startMs, endMs: shot.endMs, keyframes: [...shot.keyframes] });
      }
    });
  }
  return out;
}
