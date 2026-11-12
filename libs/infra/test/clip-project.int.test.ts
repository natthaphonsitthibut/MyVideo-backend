import { readFileSync } from 'node:fs';
import { validateProject } from '@myvideo/contracts';
import { findHighlights, type TimedSegment } from '@myvideo/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clipFrames, layoutClipProject, seededIds } from '../src/highlights/clip-project.js';
import { loadStageBundle } from '../src/render/stage-bundle.js';
import { StageTextLayout } from '../src/render/text-layout.js';

/** Real S01 excerpt (04:00–08:00) + the real recorded AI hook for its best window (hooks fixture). */
const excerpt = JSON.parse(
  readFileSync(new URL('../../domain/src/highlights/fixtures/s01-0400-0800.json', import.meta.url), 'utf8'),
) as { segments: TimedSegment[] };
const hooks = JSON.parse(
  readFileSync(new URL('../src/highlights/fixtures/hooks-s01-0400-0800.json', import.meta.url), 'utf8'),
) as { responses: { structured_output: { suggestions: { kind: string; text: string }[] } }[] };
const S01 = {
  sourceId: '01a1cd80-4521-7148-a1c5-41320a85f1b8',
  fps: { num: 30, den: 1 },
  durationFrames: 81_000,
  hasAudio: true,
};

describe('clip plan → Project with the stage text layout (real Chromium + bundled fonts)', {
  timeout: 120_000,
}, () => {
  let layout: StageTextLayout;
  beforeAll(async () => {
    layout = await StageTextLayout.open(await loadStageBundle());
  });
  afterAll(async () => layout?.close());

  const best = findHighlights({ segments: excerpt.segments }, { topN: 1 })[0];
  if (!best) throw new Error('no window');
  const words = excerpt.segments
    .slice(best.firstSegment, best.lastSegment + 1)
    .flatMap((s) => s.words.map((w) => ({ text: w.text, startMs: w.startMs, endMs: w.endMs })));
  const hookText =
    hooks.responses[0]?.structured_output.suggestions.find((s) => s.kind === 'hook')?.text ?? '';
  const plan = {
    startMs: best.startMs - 150,
    endMs: best.endMs + 200,
    words,
    title: 'เสื้อมัดย้อมวินเทจ 80 บาท',
    hook: { text: hookText, origin: 'ai' as const },
  };
  const input = {
    projectId: seededIds('test-project')(),
    merchantId: seededIds('test-merchant')(),
    source: S01,
    plan,
    seed: 'run-1:clip-1',
  };

  it('builds a valid 9:16 project: cover video, captions of every word, hook on top, all origin ai', async () => {
    const p = await layoutClipProject(layout, input);
    expect(validateProject(p).ok).toBe(true);
    expect([p.width, p.height]).toEqual([1080, 1920]);
    const { sourceInFrame, durationFrames } = clipFrames(S01, plan);
    expect(p.durationFrames).toBe(durationFrames);
    const els = Object.values(p.elements);
    const video = els.find((e) => e.type === 'video');
    expect(video).toMatchObject({
      fit: 'cover',
      sourceInFrame,
      transform: { x: 0, y: 0, scale: 1, rotation: 0 },
    });
    expect(els.every((e) => e.origin === 'ai')).toBe(true);
    expect(p.meta.createdBy).toBe('ai');

    // captions carry exactly the transcript words of the clip, in order
    const captionText = els
      .filter((e) => e.type === 'caption')
      .sort((a, b) => a.startFrame - b.startFrame)
      .flatMap((e) => (e.type === 'caption' ? e.words.map((w) => w.text) : []))
      .join('')
      .replace(/\s+/g, '');
    expect(captionText).toBe(
      words
        .map((w) => w.text)
        .join('')
        .replace(/\s+/g, ''),
    );

    // the hook: same text, explicit breaks only at its spaces, at most 3 lines, shown at the start
    const hook = els.find((e) => e.type === 'text');
    if (hook?.type !== 'text') throw new Error('no hook element');
    expect(hook.content.replace(/\n/g, ' ')).toBe(hookText.split(/\s+/).join(' '));
    expect(hook.content.split('\n').length).toBeLessThanOrEqual(3);
    expect(hook.startFrame).toBe(0);
    expect(hook.durationFrames).toBe(Math.min(durationFrames, 90));
    console.log(
      `clip ${durationFrames} frames, ${els.filter((e) => e.type === 'caption').length} caption pages, hook "${hook.content.replace(/\n/g, '⏎')}" ${hook.style?.fontSize}px`,
    );
  });

  it('is deterministic: the same plan builds the same project', async () => {
    const a = await layoutClipProject(layout, input);
    const b = await layoutClipProject(layout, input);
    expect(b).toEqual(a);
  });

  it('a long hook gets a smaller font instead of breaking a Thai word', async () => {
    const r = await layout.layoutText('เสื้อมัดย้อมวินเทจงานสอยเดียวทั้งตัวสภาพใหม่มาก', {
      fontWeight: 800,
      fontSizes: [88, 76, 64, 56],
      maxWidth: 880,
      maxLines: 3,
    });
    expect(r.text).not.toContain('\n'); // one Thai phrase without spaces is never split
    expect(r.fontSize).toBeLessThan(88);
  });
});
