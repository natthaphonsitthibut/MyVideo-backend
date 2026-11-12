import { librarySound, stylePack } from '@myvideo/contracts';
import { describe, expect, it } from 'vitest';
import { placeSoundEffects, type SfxMoment } from './sound-effects.js';

const fps = { num: 30, den: 1 };
const sfx = stylePack('sale-fast').sfx!;
const frameOf = (sec: number) => Math.round(sec * 30);

describe('placeSoundEffects', () => {
  it("starts each sound so its sync point lands on the moment's frame", () => {
    const placed = placeSoundEffects(sfx, [{ frame: 90, kind: 'cut' }], { fps, durationFrames: 600 });
    expect(placed).toHaveLength(1);
    const p = placed[0]!;
    const sound = librarySound(p.soundId)!;
    expect(p.soundId).toBe(sfx.cut[0]);
    // sync point on the timeline = start + (sync − trimmed head) in frames
    expect(p.startFrame - p.sourceInFrame + frameOf(sound.syncAtSec)).toBe(90);
    expect(p.durationFrames).toBe(Math.floor(sound.durationSec * 30));
  });

  it('trims the head of a sound whose start would fall before frame 0', () => {
    // sting-bold-short syncs 0.304 s (9 frames) in; a moment at frame 3 needs 6 frames trimmed
    const placed = placeSoundEffects(
      { ...sfx, endCard: 'sting-bold-short' },
      [{ frame: 3, kind: 'endCard' }],
      { fps, durationFrames: 600 },
    );
    expect(placed[0]).toMatchObject({ startFrame: 0, sourceInFrame: 6 });
    expect(placed[0]!.durationFrames).toBe(Math.floor(1.708 * 30) - 6);
  });

  it('cuts a sound off at the end of the clip', () => {
    const placed = placeSoundEffects(sfx, [{ frame: 595, kind: 'endCard' }], { fps, durationFrames: 600 });
    const p = placed[0]!;
    expect(p.startFrame + p.durationFrames).toBe(600);
  });

  it('volume = style gain + the sound under-speech gain (dB → linear)', () => {
    const quiet = { ...sfx, gainDb: -6 };
    const [p] = placeSoundEffects(quiet, [{ frame: 60, kind: 'price' }], { fps, durationFrames: 600 });
    const sound = librarySound(quiet.price!)!;
    expect(p!.volume).toBeCloseTo(10 ** ((sound.underVoiceoverDb - 6) / 20), 3);
    expect(p!.volume).toBeLessThan(1);
  });

  it('cycles cut sounds and keeps at least minGapMs between a cut sound and the previous sound', () => {
    const moments: SfxMoment[] = [30, 60, 120, 200, 260, 400].map((frame) => ({ frame, kind: 'cut' }));
    const placed = placeSoundEffects({ ...sfx, minGapMs: 2500 }, moments, { fps, durationFrames: 600 });
    // 30 kept; 60 (1 s later) dropped; 120 (3 s) kept; 200 (2.7 s) kept; 260 dropped; 400 kept
    expect(placed.map((p) => p.moment)).toEqual([30, 120, 200, 400]);
    expect(placed.map((p) => p.soundId)).toEqual([sfx.cut[0], sfx.cut[1], sfx.cut[0], sfx.cut[1]]);
  });

  it('a price / call-to-action moment always gets its own sound, even close to a cut sound', () => {
    const placed = placeSoundEffects(
      sfx,
      [
        { frame: 30, kind: 'cut' },
        { frame: 45, kind: 'price' },
        { frame: 70, kind: 'cta' },
      ],
      { fps, durationFrames: 600 },
    );
    expect(placed.map((p) => [p.moment, p.soundId])).toEqual([
      [30, sfx.cut[0]],
      [45, sfx.price],
      [70, sfx.cta],
    ]);
  });

  it('never overlaps two sounds on one track (two tracks; a cut sound that finds both busy is dropped)', () => {
    const placed = placeSoundEffects(
      { ...sfx, minGapMs: 0 },
      [
        { frame: 30, kind: 'price' }, // register, ~27 frames
        { frame: 33, kind: 'cta' },
        { frame: 36, kind: 'cut' }, // both tracks busy → dropped
        { frame: 120, kind: 'cut' },
      ],
      { fps, durationFrames: 600 },
    );
    expect(placed.map((p) => p.moment)).toEqual([30, 33, 120]);
    for (const track of [0, 1]) {
      const on = placed.filter((p) => p.track === track).sort((a, b) => a.startFrame - b.startFrame);
      for (let i = 1; i < on.length; i++)
        expect(on[i]!.startFrame).toBeGreaterThanOrEqual(on[i - 1]!.startFrame + on[i - 1]!.durationFrames);
    }
  });

  it('places nothing for a style without sound effects or a moment kind the style leaves empty', () => {
    expect(
      placeSoundEffects(stylePack('simple').sfx, [{ frame: 30, kind: 'cut' }], { fps, durationFrames: 600 }),
    ).toEqual([]);
    expect(
      placeSoundEffects(
        stylePack('premium').sfx,
        [
          { frame: 30, kind: 'cut' },
          { frame: 40, kind: 'price' },
        ],
        {
          fps,
          durationFrames: 600,
        },
      ),
    ).toEqual([]);
  });

  it('is exact at 29.97 fps', () => {
    const ntsc = { num: 30000, den: 1001 };
    const [p] = placeSoundEffects(sfx, [{ frame: 300, kind: 'cut' }], { fps: ntsc, durationFrames: 900 });
    const sound = librarySound(p!.soundId)!;
    const syncFrames = Math.round((sound.syncAtSec * 30000) / 1001);
    expect(p!.startFrame + syncFrames).toBe(300);
  });
});
