import { templateVersion, validateProject } from '@myvideo/contracts';
import { describe, expect, it } from 'vitest';
import type { TemplatePiece } from './template-engine.js';
import { buildTemplateProject, pieceStarts, templateCaptionWords } from './template-project.js';

const C05 = '00000000-0000-4000-8000-0000000000c5';
const C03 = '00000000-0000-4000-8000-0000000000c3';
// the review plan the engine makes from the real C05/C03 shots (template-engine.test.ts)
const pieces: TemplatePiece[] = [
  {
    slot: 0,
    sourceId: C03,
    shotIndex: 0,
    role: 'talking_head',
    inMs: 400,
    outMs: 6_700,
    text: { kind: 'title', value: 'การ์ดจอ ProArt' },
  },
  {
    slot: 1,
    sourceId: C05,
    shotIndex: 5,
    role: 'product_closeup',
    inMs: 14_250,
    outMs: 16_750,
    text: { kind: 'point', value: 'เงียบ ไม่ร้อน' },
  },
  { slot: 2, sourceId: C05, shotIndex: 8, role: 'demo', inMs: 23_250, outMs: 27_750, text: null },
];
const words = new Map([
  [
    C03,
    [
      { text: 'วันนี้', startMs: 1_100, endMs: 1_700 },
      { text: 'มารีวิว', startMs: 1_700, endMs: 2_600 },
      { text: 'ไม่อยู่ในช่วง', startMs: 9_000, endMs: 9_500 },
    ],
  ],
]);
const laid = (text: string) => ({ text, fontSize: 72, lines: 1 });

describe('template project', () => {
  it('pieces follow each other on a 30 fps timeline; caption words move with their piece', () => {
    expect(pieceStarts(pieces)).toEqual([0, 189, 264]);
    expect(templateCaptionWords(pieces, words)).toEqual([
      { text: 'วันนี้', startFrame: 21, endFrame: 39 },
      { text: 'มารีวิว', startFrame: 39, endFrame: 66 },
    ]);
  });

  it('builds a valid project: one video per piece from its own source, brand-token texts, CTA at the end', () => {
    const t = templateVersion('review', 1);
    if (!t) throw new Error('no template');
    const project = buildTemplateProject({
      projectId: '00000000-0000-4000-8000-0000000000aa',
      merchantId: '00000000-0000-4000-8000-0000000000bb',
      workflowRunId: '00000000-0000-4000-8000-0000000000cc',
      seed: 'test',
      title: 'การ์ดจอ ProArt',
      template: t,
      pieces,
      sources: [
        { sourceId: C03, durationMs: 54_500, hasAudio: true },
        { sourceId: C05, durationMs: 30_000, hasAudio: false },
      ],
      captionPages: [
        {
          startFrame: 21,
          durationFrames: 45,
          words: [
            { text: 'วันนี้', startFrame: 0, endFrame: 18 },
            { text: 'มารีวิว', startFrame: 18, endFrame: 45 },
          ],
          lines: [[0, 1]],
        },
      ],
      pieceTexts: [laid('การ์ดจอ ProArt'), laid('เงียบ ไม่ร้อน'), null],
      cta: laid('กดตะกร้า สั่งได้เลย'),
    });
    expect(validateProject(project).ok).toBe(true);
    expect(project.durationFrames).toBe(399);
    expect(project.templateRef).toEqual({ templateId: 'review', templateVersion: 1 });
    const videos = Object.values(project.elements).filter((e) => e.type === 'video');
    expect(
      videos.map((v) => (v.type === 'video' ? [v.startFrame, v.durationFrames, v.sourceInFrame] : [])),
    ).toEqual([
      [0, 189, 12],
      [189, 75, 428],
      [264, 135, 698],
    ]);
    expect(
      Object.values(project.assets)
        .map((a) => a.sourceId)
        .sort(),
    ).toEqual([C05, C03].sort());
    const texts = Object.values(project.elements).filter((e) => e.type === 'text');
    expect(
      texts.map((e) =>
        e.type === 'text' ? [e.content, e.startFrame, e.durationFrames, e.style?.color] : [],
      ),
    ).toEqual([
      ['การ์ดจอ ProArt', 0, 75, 'brand:text'],
      ['เงียบ ไม่ร้อน', 189, 75, 'brand:primary'],
      ['กดตะกร้า สั่งได้เลย', 324, 75, 'brand:primary'],
    ]);
  });
});
