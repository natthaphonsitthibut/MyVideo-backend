import { librarySound, STYLE_PACKS, stylePack, validateProject } from '@myvideo/contracts';
import { describe, expect, it } from 'vitest';
import { buildClipProject, editFrames, segmentScales } from './clip-project.js';
import { planJumpCuts } from './jump-cuts.js';

const source = {
  sourceId: '00000000-0000-4000-8000-000000000001',
  fps: { num: 30, den: 1 },
  durationFrames: 9000,
  hasAudio: true,
};
const w = (text: string, startMs: number, endMs: number, asrText?: string) =>
  asrText ? { text, startMs, endMs, origin: 'ai' as const, asrText } : { text, startMs, endMs };
// clip 10.0–16.0 s: speech 10.0–12.0, silence 12.0–14.0, speech 14.0–16.0; "เอ่อ" filler at 14.0–14.5
const plan = {
  startMs: 10_000,
  endMs: 16_000,
  title: 'เสื้อมัดย้อม ลายสวย',
  words: [
    w('ตัว', 10_000, 10_500),
    w('นี้', 10_500, 11_000),
    w('สวย', 11_000, 12_000),
    w('เอ่อ', 14_000, 14_500),
    w('80', 14_500, 15_000),
    w('บาท', 15_000, 15_500),
    w('พิมพ์', 15_500, 16_000, 'พิม'),
  ],
};
const speech = [
  { startMs: 10_000, endMs: 12_000 },
  { startMs: 14_000, endMs: 16_000 },
];

function build(styleId: string) {
  const style = stylePack(styleId);
  const cut = planJumpCuts({ startMs: plan.startMs, endMs: plan.endMs }, plan.words, speech, style.cuts);
  const frames = editFrames(source, plan, cut);
  // one caption page with every word (layout itself is covered by the stage tests)
  const pages = [
    {
      startFrame: 0,
      durationFrames: frames.durationFrames,
      words: frames.words.map(({ text, startFrame, endFrame }) => ({ text, startFrame, endFrame })),
      lines: [frames.words.map((_, i) => i)],
    },
  ];
  const project = buildClipProject({
    projectId: '00000000-0000-4000-8000-0000000000aa',
    merchantId: '00000000-0000-4000-8000-0000000000bb',
    source,
    plan,
    pages,
    endCard: { text: plan.title, fontSize: 80, lines: [plan.title] } as never,
    edit: { style, cut },
    seed: 'test',
  });
  return { project, frames, style, cut };
}

describe('style-pack edit of a clip', () => {
  it('sale-fast: jump cut on the silence and the filler, contiguous segments, valid project', () => {
    const { project, cut } = build('sale-fast');
    // silence 12.0–14.0 shrinks to 80 ms, filler 14.0–14.5 goes too
    expect(cut.segments).toEqual([
      { startMs: 10_000, endMs: 12_040 },
      { startMs: 14_500, endMs: 16_000 },
    ]);
    const videos = Object.values(project.elements).filter((e) => e.type === 'video');
    expect(videos.map((v) => [v.startFrame, v.durationFrames, v.sourceInFrame])).toEqual([
      [0, 61, 300],
      [61, 45, 435],
    ]);
    expect(project.durationFrames).toBe(106);
    expect(validateProject(project).ok).toBe(true);
    expect(project.meta.styleId).toBe('sale-fast');
  });

  it('zoom cycles per segment and punches in where a price is spoken', () => {
    const { project, style } = build('sale-fast');
    const scales = Object.values(project.elements)
      .filter((e) => e.type === 'video')
      .map((v) => (v as { transform: { scale: number } }).transform.scale);
    // segment 1 "ตัว นี้ สวย" → cycle[0]; segment 2 "80 บาท พิมพ์" → punch-in
    expect(scales).toEqual([style.zoom.cycle[0], style.zoom.punchIn]);
    // a zoomed shot moves down so the top (face) is kept, and never far enough to show an edge
    const zoomed = Object.values(project.elements).find(
      (e) => e.type === 'video' && (e as { transform: { scale: number } }).transform.scale > 1,
    ) as { transform: { scale: number; y: number } };
    const topCrop = (zoomed.transform.scale - 1) * (1920 / 2);
    expect(zoomed.transform.y).toBeGreaterThan(0);
    expect(zoomed.transform.y).toBeLessThan(topCrop);
  });

  it('camera pushes in one way inside each segment, never back out; wider again only at a cut', () => {
    const { project, style } = build('sale-fast');
    const videos = Object.values(project.elements).filter((e) => e.type === 'video');
    for (const v of videos) {
      const k = v.keyframes?.['transform.scale'];
      expect(k).toHaveLength(2);
      expect(k?.[0]?.frame).toBe(0);
      expect(k?.[1]?.frame).toBe(v.durationFrames - 1);
      expect(k?.[1]?.value).toBeCloseTo((k?.[0]?.value ?? 0) * (1 + style.zoom.drift), 3);
    }
    // the style without drift adds no keyframes
    const plain = Object.values(build('simple').project.elements).filter((e) => e.type === 'video');
    expect(plain.every((v) => v.keyframes === undefined)).toBe(true);
  });

  it('captions follow the cut timeline, keep AI-correction marks, drop the filler', () => {
    const { project } = build('sale-fast');
    const caption = Object.values(project.elements).find((e) => e.type === 'caption');
    if (caption?.type !== 'caption') throw new Error('no caption');
    expect(caption.styleRef).toBe('pop-word');
    expect(caption.words.map((x) => x.text)).toEqual(['ตัว', 'นี้', 'สวย', '80', 'บาท', 'พิมพ์']);
    // "80" was at 14.5 s in the source → right after the first segment (61 frames) on the output
    expect(caption.words[3]?.startFrame).toBe(61);
    expect(caption.words[5]).toMatchObject({ text: 'พิมพ์', origin: 'ai', asrText: 'พิม' });
  });

  it('end card sits on the last seconds and never over the opening title', () => {
    const { project } = build('sale-fast');
    const texts = Object.values(project.elements).filter((e) => e.type === 'text');
    const end = texts.find((t) => t.type === 'text' && t.content === plan.title);
    expect(end).toBeDefined();
    // clip is 106 frames, end card 2 s = 60 frames → would start at 46, but no hook here → 46
    expect(end?.startFrame).toBe(46);
    expect((end?.startFrame ?? 0) + (end?.durationFrames ?? 0)).toBe(project.durationFrames);
  });

  it('simple: keeps fillers, no zoom, no end card', () => {
    const { project } = build('simple');
    const videos = Object.values(project.elements).filter((e) => e.type === 'video');
    // 2 s silence > 800 ms → still one jump cut; filler stays
    expect(videos).toHaveLength(2);
    expect(videos.every((v) => (v as { transform: { scale: number } }).transform.scale === 1)).toBe(true);
    expect(Object.values(project.elements).some((e) => e.type === 'text')).toBe(false);
  });

  it('every style pack builds a valid project from the same plan', () => {
    for (const p of STYLE_PACKS) expect(validateProject(build(p.id).project).ok, p.id).toBe(true);
  });

  it('sale-fast: sound effects from the library land their sync point on the cut / card frame', () => {
    const { project } = build('sale-fast');
    const audioTracks = project.tracks.filter((t) => t.kind === 'audio');
    expect(audioTracks.length).toBeGreaterThan(0);
    const sounds = audioTracks.flatMap((t) => t.elementIds.map((id) => project.elements[id]!));
    const placed = sounds.map((e) => {
      if (e.type !== 'audio') throw new Error('not audio');
      const asset = project.assets[e.assetId]!;
      expect(asset).toMatchObject({ kind: 'audio', hasAudio: true });
      expect(asset.sourceId).toBeUndefined();
      const sound = librarySound(asset.libraryId!)!;
      expect(e.volume).toBeLessThan(1);
      return { id: sound.id, sync: e.startFrame - e.sourceInFrame + Math.round(sound.syncAtSec * 30) };
    });
    // the second shot ("80 บาท") is a punch-in on a price → the price sound on its first frame (61), not a whoosh;
    // the end card appears at frame 46 → the closing sting meets it
    expect(placed).toContainEqual({ id: 'money-register', sync: 61 });
    expect(placed).toContainEqual({ id: 'sting-bold-short', sync: 46 });
    expect(placed.some((p) => p.id.startsWith('whoosh') && p.sync === 61)).toBe(false);
    expect(validateProject(project).ok).toBe(true);
  });

  it('simple has no sound effects; premium only its quiet title / end-card sounds', () => {
    const simple = build('simple').project;
    expect(simple.tracks.some((t) => t.kind === 'audio')).toBe(false);
    expect(Object.values(simple.assets).some((a) => a.libraryId)).toBe(false);
    const premium = build('premium').project;
    const ids = Object.values(premium.assets)
      .map((a) => a.libraryId)
      .filter(Boolean);
    expect(ids).toEqual(['sting-minimal-short']);
  });

  it('segmentScales: never punches in on two shots in a row', () => {
    const shot = (words: string[]) => ({ sourceInFrame: 0, startFrame: 0, durationFrames: 10, words });
    const price = ['80', 'บาท'];
    const style = stylePack('sale-fast');
    expect(segmentScales(style, [shot(price), shot(price), shot(['สวย']), shot(price)])).toEqual([
      style.zoom.punchIn,
      style.zoom.cycle[1],
      style.zoom.cycle[0],
      style.zoom.punchIn,
    ]);
  });

  it('segmentScales: no punch-in for a style without one', () => {
    expect(
      segmentScales(stylePack('premium'), [
        { sourceInFrame: 0, startFrame: 0, durationFrames: 10, words: ['80', 'บาท'] },
      ]),
    ).toEqual([1]);
  });
});
