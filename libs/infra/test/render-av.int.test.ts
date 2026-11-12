import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRenderOutput, LOUDNESS_TARGET } from '@myvideo/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { footageClip } from '../../../test/footage.js';
import { greyFrames, loudness, mse, pcm, xcorrLagMs } from '../../../test/render-helpers.js';
import { ChromiumRenderer } from '../src/render/chromium-renderer.js';
import { probeRendered } from '../src/render/probe-rendered.js';
import { loadStageBundle } from '../src/render/stage-bundle.js';

// Real talking-head clip C03 (576×720, 44.1 kHz speech, no silence) + Chromium → outside the sandbox.
const C03 = footageClip('talkinghead-th-portrait.mp4');
const ASSET = '00000000-0000-4000-8000-0000000000a1';
const TRACK = '00000000-0000-4000-8000-0000000000b1';
const EL1 = '00000000-0000-4000-8000-0000000000c1';
const EL2 = '00000000-0000-4000-8000-0000000000c2';
const FPS = 30;

/** 15 s: frames 0–239 show source 10 s…, frames 240–449 show source 30 s… (a hard cut at 8 s). */
const segments = [
  { id: EL1, start: 0, frames: 240, sourceIn: 10 * FPS },
  { id: EL2, start: 240, frames: 210, sourceIn: 30 * FPS },
];
const project = {
  schemaVersion: 1,
  id: '00000000-0000-4000-8000-0000000000d1',
  merchantId: '00000000-0000-4000-8000-0000000000e1',
  fps: { num: FPS, den: 1 },
  width: 1080,
  height: 1920,
  durationFrames: 450,
  assets: {
    [ASSET]: {
      sourceId: '00000000-0000-4000-8000-0000000000f1',
      kind: 'video',
      durationFrames: 1635,
      hasAudio: true,
    },
  },
  tracks: [{ id: TRACK, kind: 'video', elementIds: [EL1, EL2] }],
  elements: Object.fromEntries(
    segments.map((s) => [
      s.id,
      {
        type: 'video',
        id: s.id,
        trackId: TRACK,
        startFrame: s.start,
        durationFrames: s.frames,
        origin: 'user',
        assetId: ASSET,
        sourceInFrame: s.sourceIn,
        playbackRate: 1,
        volume: 1,
        transform: { x: 0, y: 0, scale: 1, rotation: 0 },
        fit: 'cover',
      },
    ]),
  ),
  meta: { createdBy: 'user' },
};
/** Output second → source second. */
const sourceAt = (t: number) => {
  const s = segments.find((x) => t * FPS >= x.start && t * FPS < x.start + x.frames) ?? segments[0];
  return s ? s.sourceIn / FPS + (t - s.start / FPS) : 0;
};

let dir: string;
let out: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'myvideo-render-av-'));
  out = join(dir, 'out.mp4');
  if (!C03) return;
  const renderer = new ChromiumRenderer(await loadStageBundle());
  await renderer.render(
    { project: project as never, media: { [ASSET]: C03 }, preset: 'standard', outPath: out },
    { signal: new AbortController().signal },
  );
}, 600_000);
afterAll(() => rm(dir, { recursive: true, force: true }));

describe.skipIf(!C03)('render A/V sync and loudness on real footage (C03)', () => {
  it('passes the output validation step', async () => {
    expect(checkRenderOutput(await probeRendered(out), { ...project, frames: 450 })).toEqual([]);
  });

  it('audio lines up with the source within 1 frame at 3 points (cross-correlation)', async () => {
    const lags: number[] = [];
    for (const t of [3, 6, 11]) {
      const needle = await pcm(out, t, 1);
      const hay = await pcm(C03 as string, sourceAt(t) - 0.2, 1.4);
      lags.push(xcorrLagMs(needle, hay, 200));
    }
    console.log('audio lag ms at 3/6/11 s:', lags);
    for (const l of lags) expect(Math.abs(l)).toBeLessThanOrEqual(1000 / FPS);
  });

  it('video shows the source frame the timeline says, at 3 points (best match of ±2 frames)', async () => {
    const cover = 'scale=1536:1920,crop=1080:1920'; // object-fit: cover of 576×720 into 1080×1920
    const offsets: number[] = [];
    for (const t of [3, 6, 11]) {
      const [o] = await greyFrames(out, { startSec: t, frames: 1 });
      const cands = await greyFrames(C03 as string, {
        startSec: sourceAt(t) - 2 / FPS,
        frames: 5,
        vf: cover,
      });
      const errs = cands.map((c) => mse(o as Uint8Array, c));
      offsets.push(errs.indexOf(Math.min(...errs)) - 2);
      console.log(`t=${t}s MSE for offsets −2…+2:`, errs.map((e) => e.toFixed(2)).join(' '));
    }
    console.log('video best-match offset (frames) at 3/6/11 s:', offsets);
    for (const o of offsets) expect(Math.abs(o)).toBeLessThanOrEqual(1);
  });

  it('integrated loudness is the export target ±1 LU', async () => {
    const l = await loudness(out);
    console.log('output loudness:', l);
    expect(Math.abs(l.i - LOUDNESS_TARGET.integrated)).toBeLessThanOrEqual(1);
    expect(l.tp).toBeLessThanOrEqual(LOUDNESS_TARGET.truePeak + 0.5);
  });
});
