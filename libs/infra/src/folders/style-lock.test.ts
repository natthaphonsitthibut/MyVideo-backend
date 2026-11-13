import { STYLE_PACKS } from '@myvideo/contracts';
import { expect, it } from 'vitest';
import { layoutClip } from '../highlights/live-to-clips.js';
import { freezeStyle } from './style-lock.js';

it('copies the complete resolved recipe and rejects unknown catalogue IDs', () => {
  for (const pack of STYLE_PACKS) {
    const frozen = freezeStyle(pack.id, 'fixed-seed');
    expect(frozen.pack).toEqual(pack);
    expect(frozen.pack).not.toBe(pack);
    expect(freezeStyle(pack.id, 'fixed-seed')).toEqual(frozen);
  }
  expect(() => freezeStyle('missing', 'seed')).toThrow();
});
it('locked style gives byte-identical Project JSON across runs with the same resolved input', async () => {
  const input = {
    version: 1 as const,
    startMs: 0,
    endMs: 5000,
    words: [],
    speech: [],
    title: '',
    hook: null,
    frozenStyle: freezeStyle('simple', 'permanent-seed'),
  };
  const layout = async () => ({ close: async () => {} }) as never;
  const source = {
    sourceId: '00000000-0000-4000-8000-000000000001',
    fps: { num: 30, den: 1 },
    durationFrames: 150,
    hasAudio: true,
    width: 1080,
    height: 1920,
  };
  const common = { merchantId: '00000000-0000-4000-8000-000000000002', source, input, styleId: 'simple' };
  const first = await layoutClip(layout, {
    ...common,
    projectId: '00000000-0000-4000-8000-000000000003',
    workflowRunId: '00000000-0000-4000-8000-000000000004',
    rank: 1,
  });
  const second = await layoutClip(layout, {
    ...common,
    projectId: '00000000-0000-4000-8000-000000000005',
    workflowRunId: '00000000-0000-4000-8000-000000000006',
    rank: 2,
  });
  expect(JSON.stringify(first)).toBe(JSON.stringify(second));
});
