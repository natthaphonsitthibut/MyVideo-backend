import { librarySound, type StylePack } from '@myvideo/contracts';

/** A moment on the output timeline that a style may mark with a sound. */
export type SfxMoment = { frame: number; kind: 'cut' | 'price' | 'cta' | 'hook' | 'endCard' };

/** One library sound placed on the output timeline (frames at the project fps). */
export type PlacedSound = {
  soundId: string;
  /** The moment the sound's sync point meets. */
  moment: number;
  startFrame: number;
  /** Frames trimmed off the sound's head (its start would have been before frame 0). */
  sourceInFrame: number;
  durationFrames: number;
  /** Linear gain (style gain + the sound's under-speech gain). */
  volume: number;
  /** Audio track index (0 or 1): sounds never overlap on one track. */
  track: 0 | 1;
};

type Fps = { num: number; den: number };

const secToFrames = (sec: number, fps: Fps) => (sec * fps.num) / fps.den;

/** Library sound length in whole project frames (never more than the file holds). */
export const soundFrames = (durationSec: number, fps: Fps) =>
  Math.max(1, Math.floor(secToFrames(durationSec, fps)));

/**
 * Pure: the style's sounds for these moments (D-026). Each sound starts at (moment − its sync point), so the hit /
 * middle of the whoosh lands on the moment's frame; a start before 0 trims the head, the clip end trims the tail.
 * Cut sounds cycle through `sfx.cut` and keep `minGapMs` from the previous sound (a whoosh at every shot change
 * of a fast style would be noise); price / call-to-action / title / end-card moments always get theirs. Two audio
 * tracks; a sound that finds both busy is dropped. Deterministic: same input → same placement.
 */
export function placeSoundEffects(
  sfx: StylePack['sfx'],
  moments: readonly SfxMoment[],
  opts: { fps: Fps; durationFrames: number },
): PlacedSound[] {
  if (!sfx) return [];
  const { fps, durationFrames } = opts;
  const minGap = secToFrames(sfx.minGapMs / 1000, fps);
  const busyUntil: [number, number] = [0, 0];
  const placed: PlacedSound[] = [];
  let lastMoment = Number.NEGATIVE_INFINITY;
  let cutIndex = 0;
  for (const m of [...moments].sort((a, b) => a.frame - b.frame)) {
    let soundId: string | null;
    if (m.kind === 'cut') {
      if (sfx.cut.length === 0 || m.frame - lastMoment < minGap) continue;
      soundId = sfx.cut[cutIndex % sfx.cut.length] ?? null;
    } else soundId = sfx[m.kind];
    const sound = soundId ? librarySound(soundId) : undefined;
    if (!soundId || !sound) continue;
    const syncFrames = Math.round(secToFrames(sound.syncAtSec, fps));
    const start = m.frame - syncFrames;
    const sourceInFrame = Math.max(0, -start);
    const startFrame = Math.max(0, start);
    const durationFramesOut = Math.min(
      soundFrames(sound.durationSec, fps) - sourceInFrame,
      durationFrames - startFrame,
    );
    if (durationFramesOut < 1) continue;
    const track = busyUntil[0] <= startFrame ? 0 : busyUntil[1] <= startFrame ? 1 : null;
    if (track === null) continue;
    busyUntil[track] = startFrame + durationFramesOut;
    if (m.kind === 'cut') cutIndex++;
    lastMoment = m.frame;
    placed.push({
      soundId,
      moment: m.frame,
      startFrame,
      sourceInFrame,
      durationFrames: durationFramesOut,
      volume: Math.round(10 ** ((sound.underVoiceoverDb + sfx.gainDb) / 20) * 1000) / 1000,
      track,
    });
  }
  return placed;
}
