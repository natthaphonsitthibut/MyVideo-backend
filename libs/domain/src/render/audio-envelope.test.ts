import { expect, it } from 'vitest';
import { duckingExpression, duckingGain, fadeGain } from './audio-envelope.js';
import { withMusicTrack } from './music-project.js';
import { audioFilterGraph, planRender } from './render-plan.js';

it('ducks by 9 dB, ramps before/after speech and is deterministic under backward seeks', () => {
  const d = { gainDb: -9, attackFrames: 6, releaseFrames: 12, speech: [{ startFrame: 30, endFrame: 60 }] };
  expect(duckingGain(d, 0)).toBe(1);
  expect(duckingGain(d, 30)).toBeCloseTo(10 ** (-9 / 20));
  expect(duckingGain(d, 66)).toBeGreaterThan(duckingGain(d, 60));
  expect(duckingGain(d, 72)).toBe(1);
  expect(duckingGain(d, 27)).toBeCloseTo((1 + 10 ** (-9 / 20)) / 2);
  expect(fadeGain(0, 300, 15, 30)).toBe(0);
  const graph = audioFilterGraph(
    [{ input: 0, volume: 0.14, rate: 1, delaySec: 0, duck: duckingExpression(d, { num: 30, den: 1 }) }],
    10,
  );
  expect(graph).toContain('eval=frame');
  expect(graph).toContain('normalize=0');
});
it('places measured music under a real caption price without moving speech and carries the envelope into the render plan', () => {
  const p = {
    fps: { num: 30, den: 1 },
    width: 1080,
    height: 1920,
    durationFrames: 300,
    assets: {},
    tracks: [],
    elements: {
      c: {
        id: 'c',
        type: 'caption',
        startFrame: 30,
        durationFrames: 60,
        words: [{ text: '80 บาท', startFrame: 0, endFrame: 60 }],
      },
    },
  };
  let id = 0;
  const output = withMusicTrack(
    p,
    {
      musicId: 'music',
      durationMs: 30000,
      analysis: { bpm: 120, firstBeatSec: 0, beatsSec: [0, 0.5], dropsSec: [5] },
    },
    () => `id-${id++}`,
  );
  expect(output.elements.c).toEqual(p.elements.c);
  const plan = planRender(output);
  expect(plan.audio[0]?.sourceAssetId).toBe('id-0');
  expect(plan.audio[0]?.startSec).toBe(4);
  expect(plan.audio[0]?.ducking?.gainDb).toBe(-9);
});
