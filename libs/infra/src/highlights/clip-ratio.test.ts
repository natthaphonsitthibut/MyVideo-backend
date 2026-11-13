import { STYLE_PACKS, stylePack, validateProject } from '@myvideo/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildClipProject,
  type ClipSourceInfo,
  editFrames,
  layoutLint,
  OUTPUT_FRAMES,
  type OutputRatio,
} from './clip-project.js';
import { planJumpCuts } from './jump-cuts.js';

/** E12-F09: the same clip plan laid out for every output ratio. Pure builder — layout itself is covered by stage tests. */
const portrait: ClipSourceInfo = {
  sourceId: '00000000-0000-4000-8000-000000000001',
  fps: { num: 30, den: 1 },
  durationFrames: 9000,
  hasAudio: true,
  width: 406,
  height: 720,
};
const landscape: ClipSourceInfo = { ...portrait, width: 1920, height: 1080 };
const w = (text: string, startMs: number, endMs: number) => ({ text, startMs, endMs });
const plan = {
  startMs: 10_000,
  endMs: 16_000,
  title: 'เสื้อมัดย้อม ลายสวย',
  hook: { text: 'ลายนี้มีตัวเดียว', origin: 'ai' as const },
  words: [w('ตัว', 10_000, 10_500), w('นี้', 10_500, 11_000), w('80', 14_500, 15_000), w('บาท', 15_000, 15_500)],
};
const speech = [
  { startMs: 10_000, endMs: 12_000 },
  { startMs: 14_000, endMs: 16_000 },
];
const laid = (text: string, fontSize: number) => ({ text, fontSize, lines: [text] }) as never;

function build(opts: { styleId?: string; ratio?: OutputRatio; source?: ClipSourceInfo; faceX?: number }) {
  const source = opts.source ?? portrait;
  const style = stylePack(opts.styleId ?? 'sale-fast');
  const cut = planJumpCuts({ startMs: plan.startMs, endMs: plan.endMs }, plan.words, speech, style.cuts);
  const frames = editFrames(source, plan, cut);
  const pages = [
    {
      startFrame: 0,
      durationFrames: frames.durationFrames,
      words: frames.words.map(({ text, startFrame, endFrame }) => ({ text, startFrame, endFrame })),
      lines: [frames.words.map((_, i) => i)],
    },
  ];
  return buildClipProject({
    projectId: '00000000-0000-4000-8000-0000000000aa',
    merchantId: '00000000-0000-4000-8000-0000000000bb',
    source,
    plan,
    pages,
    hook: laid(plan.hook.text, 76),
    endCard: laid(plan.title, 68),
    graphics: { prices: [{ frame: 20, text: laid('80 บาท', 84) }], cta: laid('กดตะกร้าเลย', 64) },
    edit: { style, cut },
    seed: 'ratio',
    ...(opts.ratio ? { ratio: opts.ratio } : {}),
    ...(opts.faceX !== undefined ? { faceX: opts.faceX } : {}),
  });
}
const videos = (p: ReturnType<typeof build>) => Object.values(p.elements).filter((e) => e.type === 'video');

describe('output ratio (E12-F09)', () => {
  it('9:16 stays exactly what it was before ratios existed (no ratio given = 9:16)', () => {
    expect(JSON.stringify(build({ ratio: '9:16' }))).toBe(JSON.stringify(build({})));
    expect(build({})).toMatchObject({ width: 1080, height: 1920 });
  });

  it('canvas sizes per ratio', () => {
    for (const [ratio, f] of Object.entries(OUTPUT_FRAMES))
      expect(build({ ratio: ratio as OutputRatio })).toMatchObject({ width: f.width, height: f.height });
  });

  it('a phone-vertical video in 16:9 is shown whole (contain) over a full-frame designed background, never stretched', () => {
    const p = build({ ratio: '16:9' });
    for (const v of videos(p)) expect(v.fit).toBe('contain');
    const bg = Object.values(p.elements).find((e) => e.type === 'shape');
    expect(bg).toMatchObject({
      shape: 'rect',
      width: 1920,
      height: 1080,
      startFrame: 0,
      durationFrames: p.durationFrames,
    });
    // the background is drawn first (bottom track)
    expect(p.tracks[0]?.elementIds).toEqual([bg?.id]);
    expect(Object.values(p.elements).some((e) => 'fit' in e && e.fit === 'fill')).toBe(false);
  });

  it('a 16:9 video in 9:16 fills the frame and is shifted so the face stays in view (clamped to the picture)', () => {
    const centred = build({ source: landscape });
    for (const v of videos(centred)) expect(v.fit).toBe('cover');
    expect(videos(centred).every((v) => v.transform.x === 0)).toBe(true);
    // face at 25 % from the left: shift right by (0.5 − 0.25) × displayed width (1920 × 1920/1080 = 3413 px)
    const left = build({ source: landscape, faceX: 0.25 });
    const base = videos(left).find((v) => v.transform.scale === 1);
    expect(base?.transform.x).toBe(853);
    // a face at the very edge cannot pull the picture off the frame: |x| ≤ (3413 − 1080) / 2
    const edge = build({ source: landscape, faceX: 0 });
    const e = videos(edge).find((v) => v.transform.scale === 1);
    expect(e?.transform.x).toBe(1167);
  });

  it('text keeps its place relative to the frame height and is scaled for the smaller frame', () => {
    const tall = build({});
    const wide = build({ ratio: '16:9' });
    const cap = (p: ReturnType<typeof build>) => Object.values(p.elements).find((e) => e.type === 'caption');
    expect(cap(wide)?.transform.y).toBe(Math.round(((cap(tall)?.transform.y ?? 0) * 1080) / 1920));
    expect(cap(wide)?.transform.scale).toBe(OUTPUT_FRAMES['16:9'].textScale);
    expect(cap(tall)?.transform.scale).toBe(1);
  });

  it('every style × every ratio × both source shapes: valid project and layout lint = 0', () => {
    for (const pack of STYLE_PACKS)
      for (const ratio of Object.keys(OUTPUT_FRAMES) as OutputRatio[])
        for (const source of [portrait, landscape]) {
          const p = build({ styleId: pack.id, ratio, source, faceX: 0.3 });
          expect(validateProject(p).ok, `${pack.id} ${ratio}`).toBe(true);
          expect(layoutLint(p), `${pack.id} ${ratio} ${source.width}x${source.height}`).toEqual([]);
        }
  });

  it('layout lint catches text pushed off the frame', () => {
    const p = build({ ratio: '16:9' });
    const cap = Object.values(p.elements).find((e) => e.type === 'caption');
    if (cap && 'transform' in cap) cap.transform.y = 600;
    expect(layoutLint(p).length).toBeGreaterThan(0);
  });
});
