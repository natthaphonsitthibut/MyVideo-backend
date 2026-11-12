import { describe, expect, it } from 'vitest';
import { audioFilterGraph, planRender, type RenderProject, renderCacheKey } from './render-plan.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const T = '00000000-0000-4000-8000-0000000000aa';
const V1 = '00000000-0000-4000-8000-000000000001';
const V2 = '00000000-0000-4000-8000-000000000002';
const C1 = '00000000-0000-4000-8000-000000000003';

const media = (over: Record<string, unknown>): any => ({
  type: 'video',
  trackId: T,
  origin: 'user',
  playbackRate: 1,
  volume: 1,
  fit: 'cover',
  transform: { x: 0, y: 0, scale: 1, rotation: 0 },
  ...over,
});

function project(over: Partial<RenderProject> = {}): RenderProject {
  return {
    fps: { num: 30, den: 1 },
    width: 1080,
    height: 1920,
    durationFrames: 450,
    assets: {
      [A]: { sourceId: 's-a', kind: 'video', durationFrames: 81_000, hasAudio: true },
      [B]: { sourceId: 's-b', kind: 'video', durationFrames: 900, hasAudio: false },
    },
    elements: {
      [V1]: media({ id: V1, assetId: A, startFrame: 0, durationFrames: 300, sourceInFrame: 21_667 }),
      [V2]: media({
        id: V2,
        assetId: B,
        startFrame: 300,
        durationFrames: 150,
        sourceInFrame: 30,
        volume: 0.5,
      }),
      [C1]: { id: C1, type: 'caption', trackId: T, startFrame: 0, durationFrames: 90, words: [], lines: [] },
    },
    ...over,
  } as RenderProject;
}

describe('planRender', () => {
  it('cuts each video element from its source at the project fps and re-points the element', () => {
    const plan = planRender(project());
    expect(plan.cuts).toEqual([
      { assetId: V1, sourceAssetId: A, startSec: 21_667 / 30, durationSec: 300 / 30 },
      { assetId: V2, sourceAssetId: B, startSec: 1, durationSec: 5 },
    ]);
    const v1 = plan.project.elements[V1] as { assetId: string; sourceInFrame: number };
    expect(v1).toMatchObject({ assetId: V1, sourceInFrame: 0 });
    expect(plan.project.assets[V1]).toEqual({
      sourceId: 's-a',
      kind: 'video',
      durationFrames: 300,
      hasAudio: false,
    });
    // captions untouched, originals no longer referenced
    expect(plan.project.elements[C1]).toEqual(project().elements[C1]);
    expect(Object.keys(plan.project.assets).sort()).toEqual([V1, V2].sort());
  });

  it('covers the source range a faster playback rate reads', () => {
    const p = project();
    (p.elements[V1] as { playbackRate: number }).playbackRate = 1.5;
    expect(planRender(p).cuts[0]?.durationSec).toBeCloseTo((300 * 1.5) / 30, 9);
  });

  it('keeps rational fps exact (29.97)', () => {
    const plan = planRender(project({ fps: { num: 30000, den: 1001 } }));
    expect(plan.cuts[0]?.startSec).toBeCloseTo((21_667 * 1001) / 30000, 12);
    expect(plan.totalSec).toBeCloseTo((450 * 1001) / 30000, 12);
  });

  it('plans audio only for elements that have sound', () => {
    const plan = planRender(project());
    expect(plan.audio).toEqual([
      {
        sourceAssetId: A,
        startSec: 21_667 / 30,
        durationSec: 10,
        delaySec: 0,
        rate: 1,
        volume: 1,
      },
    ]);
    const p = project();
    (p.elements[V1] as { volume: number }).volume = 0;
    expect(planRender(p).audio).toEqual([]);
  });

  it('passes images through and plans audio elements', () => {
    const p = project({
      assets: {
        [A]: { sourceId: 's-a', kind: 'audio', durationFrames: 900, hasAudio: true },
        [B]: { sourceId: 's-b', kind: 'image', durationFrames: 1, hasAudio: false },
      },
      elements: {
        [V1]: media({
          id: V1,
          type: 'audio',
          assetId: A,
          startFrame: 30,
          durationFrames: 60,
          sourceInFrame: 0,
        }),
        [V2]: { ...media({ id: V2, type: 'image', assetId: B, startFrame: 0, durationFrames: 60 }) },
      },
    });
    const plan = planRender(p);
    expect(plan.cuts).toEqual([]);
    expect(plan.images).toEqual([B]);
    expect(plan.audio).toEqual([
      { sourceAssetId: A, startSec: 0, durationSec: 2, delaySec: 1, rate: 1, volume: 1 },
    ]);
    expect(plan.project.assets[B]).toEqual(p.assets[B]);
  });
});

describe('audioFilterGraph', () => {
  it('trims, retimes, delays and mixes each clip into one track of exact length', () => {
    const g = audioFilterGraph(
      [
        { input: 1, rate: 1, volume: 1, delaySec: 0 },
        { input: 2, rate: 2, volume: 0.5, delaySec: 1.5 },
      ],
      15,
    );
    expect(g).toBe(
      '[1:a]aresample=48000,asetpts=PTS-STARTPTS,volume=1,adelay=0:all=1[a0];' +
        '[2:a]aresample=48000,asetpts=PTS-STARTPTS,atempo=2,volume=0.5,adelay=1500:all=1[a1];' +
        '[a0][a1]amix=inputs=2:normalize=0:duration=longest,asetpts=N/SR/TB,apad,atrim=0:15,asetpts=PTS-STARTPTS[aout]',
    );
  });

  it('re-times the mix from its sample count before trimming (jump-cut clips lost their tail)', () => {
    // Real case (S01a, 10 jump-cut clips): amix output timestamps started 1.867 s late, so atrim=0:22.9 kept only
    // 21.033 s. Counting samples instead of trusting amix timestamps gives 22.900 s, aligned within ±0.2 ms.
    const g = audioFilterGraph(
      Array.from({ length: 10 }, (_, i) => ({ input: i, rate: 1, volume: 1, delaySec: i * 2 })),
      22.9,
    );
    expect(g).toMatch(/amix=inputs=10:normalize=0:duration=longest,asetpts=N\/SR\/TB,apad,atrim=0:22\.9/);
  });

  it('makes silence when nothing has sound', () => {
    expect(audioFilterGraph([], 2.5)).toBe('anullsrc=r=48000:cl=stereo,atrim=0:2.5[aout]');
  });

  it('chains atempo for rates outside 0.5–2', () => {
    expect(audioFilterGraph([{ input: 1, rate: 4, volume: 1, delaySec: 0 }], 1)).toContain(
      'atempo=2,atempo=2,',
    );
    expect(audioFilterGraph([{ input: 1, rate: 0.25, volume: 1, delaySec: 0 }], 1)).toContain(
      'atempo=0.5,atempo=0.5,',
    );
  });
});

describe('renderCacheKey', () => {
  it('is the version + preset + stage version', () => {
    expect(renderCacheKey('v-id', 'standard', 'abc123def456')).toBe('v-id:standard:abc123def456');
  });
});
