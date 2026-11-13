import { librarySound, STYLE_PACKS, stylePack, validateProject } from '@myvideo/contracts';
import { describe, expect, it } from 'vitest';
import { buildClipProject, CAMERA_RULES, editFrames, segmentScales, segmentShots } from './clip-project.js';
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

/** The pack without long-take re-frames: isolates the price punch-in / jump-cut camera rules. */
function staticPack(styleId: string) {
  const s = stylePack(styleId);
  return { ...s, cuts: { ...s.cuts, maxShotMs: null } };
}

function build(styleId: string, noReframe = false) {
  const style = noReframe ? staticPack(styleId) : stylePack(styleId);
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
  it('frames portrait footage in landscape over an editable style-colour backdrop without duplicate video', () => {
    const style = stylePack('sale-fast');
    const doc = buildClipProject({
      projectId: '00000000-0000-4000-8000-0000000000aa',
      merchantId: '00000000-0000-4000-8000-0000000000bb',
      source: { ...source, width: 1080, height: 1920 },
      plan,
      pages: [],
      ratio: '16:9',
      seed: 'landscape',
      edit: { style, cut: planJumpCuts(plan, plan.words, speech, style.cuts) },
    });
    const backdrop = Object.values(doc.elements).find((e) => e.type === 'shape' && e.width === 1920);
    expect(backdrop?.type === 'shape' && backdrop.fill).toBe(style.hook.background);
    expect(Object.values(doc.elements).filter((e) => e.type === 'video')).toHaveLength(2);
    expect(
      Object.values(doc.elements).filter((e) => e.type === 'shape' && e.shape === 'ellipse'),
    ).toHaveLength(2);
    expect(validateProject(doc).ok).toBe(true);
  });
  it('sale-fast: jump cut on the silence and the filler, contiguous segments, valid project', () => {
    const { project, cut } = build('sale-fast');
    // silence 12.0–14.0 keeps the measured 200-ms tail and 100-ms lead, filler 14.0–14.5 goes too
    expect(cut.segments).toEqual([
      { startMs: 10_000, endMs: 12_200 },
      { startMs: 14_500, endMs: 16_000 },
    ]);
    const videos = Object.values(project.elements).filter((e) => e.type === 'video');
    expect(videos.map((v) => [v.startFrame, v.durationFrames, v.sourceInFrame])).toEqual([
      [0, 66, 300],
      [66, 45, 435],
    ]);
    expect(project.durationFrames).toBe(111);
    expect(validateProject(project).ok).toBe(true);
    expect(project.meta.styleId).toBe('sale-fast');
  });

  it('the price shot 2 s in keeps the base framing (too soon after the start to re-frame)', () => {
    const { project } = build('sale-fast', true);
    const scales = Object.values(project.elements)
      .filter((e) => e.type === 'video')
      .map((v) => (v as { transform: { scale: number } }).transform.scale);
    expect(scales).toEqual([1, 1]);
  });

  it('a punch-in on a spoken price keeps the face: the zoomed shot moves down, never showing an edge', () => {
    const style = stylePack('sale-fast');
    // 3 s of talk, a pause, the price (2 s), a pause, 8 s more talk → the price shot starts 3 s in and is
    // released at the next jump cut 2 s later; zoomed 2 s of ~13 s stays within the 20 % share
    const plan2 = {
      startMs: 10_000,
      endMs: 27_000,
      title: 'มัดย้อม',
      words: [
        w('ตัว', 10_000, 11_000),
        w('นี้', 11_000, 12_000),
        w('สวย', 12_000, 13_000),
        w('80', 15_000, 16_000),
        w('บาท', 16_000, 17_000),
        w('ผ้า', 19_000, 23_000),
        w('นุ่ม', 23_000, 27_000),
      ],
    };
    const speech2 = [
      { startMs: 10_000, endMs: 13_000 },
      { startMs: 15_000, endMs: 17_000 },
      { startMs: 19_000, endMs: 27_000 },
    ];
    const cut = planJumpCuts(
      { startMs: plan2.startMs, endMs: plan2.endMs },
      plan2.words,
      speech2,
      style.cuts,
    );
    const frames = editFrames(source, plan2, cut);
    const project = buildClipProject({
      projectId: '00000000-0000-4000-8000-0000000000aa',
      merchantId: '00000000-0000-4000-8000-0000000000bb',
      source,
      plan: plan2,
      pages: [],
      edit: { style, cut },
      seed: 'test',
    });
    expect(frames.segments).toHaveLength(3);
    const videos = Object.values(project.elements).filter((e) => e.type === 'video') as {
      transform: { scale: number; y: number };
    }[];
    expect(videos.map((v) => v.transform.scale)).toEqual([1, style.zoom.punchIn, 1]);
    const zoomed = videos[1] as { transform: { scale: number; y: number } };
    const topCrop = (zoomed.transform.scale - 1) * (1920 / 2);
    expect(zoomed.transform.y).toBeGreaterThan(0);
    expect(zoomed.transform.y).toBeLessThan(topCrop);
  });

  it('camera drift is one slow push across shots of the same framing: no snap back at a cut', () => {
    const { project, style } = build('sale-fast', true);
    const videos = Object.values(project.elements)
      .filter((e) => e.type === 'video')
      .sort((a, b) => a.startFrame - b.startFrame);
    const values = videos.flatMap((v) => (v.keyframes?.['transform.scale'] ?? []).map((k) => k.value));
    // monotonic over the whole run (both shots keep the base framing here), total push = the style's drift
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1] ?? 0);
    expect(values[0]).toBe(1);
    expect(values.at(-1)).toBeCloseTo(1 + style.zoom.drift, 4);
    for (const v of videos) {
      const k = v.keyframes?.['transform.scale'];
      expect(k?.[0]?.frame).toBe(0);
      expect(k?.[1]?.frame).toBe(v.durationFrames - 1);
    }
    // the style without drift adds no keyframes
    const plain = Object.values(build('simple').project.elements).filter((e) => e.type === 'video');
    expect(plain.every((v) => v.keyframes === undefined)).toBe(true);
  });

  it('captions follow the cut timeline, keep AI-correction marks, drop the filler', () => {
    const { project } = build('sale-fast');
    const caption = Object.values(project.elements).find((e) => e.type === 'caption');
    if (caption?.type !== 'caption') throw new Error('no caption');
    expect(caption.styleRef).toBe('stress-bounce');
    expect(caption.words.map((x) => x.text)).toEqual(['ตัว', 'นี้', 'สวย', '80', 'บาท', 'พิมพ์']);
    // "80" was at 14.5 s in the source → right after the first segment (66 frames) on the output
    expect(caption.words[3]?.startFrame).toBe(66);
    expect(caption.words[5]).toMatchObject({ text: 'พิมพ์', origin: 'ai', asrText: 'พิม' });
  });

  it('end card sits on the last seconds and never over the opening title', () => {
    const { project } = build('sale-fast');
    const texts = Object.values(project.elements).filter((e) => e.type === 'text');
    const end = texts.find((t) => t.type === 'text' && t.content === plan.title);
    expect(end).toBeDefined();
    // clip is 111 frames, end card 2.5 s = 75 frames → starts at 36 (no hook here to protect)
    expect(end?.startFrame).toBe(36);
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
    // the second shot ("80 บาท") is a punch-in on a price → the price sound on its first frame (66);
    // the end card appears at frame 36 → the closing sting meets it; plain cuts get no sound in this style
    expect(placed).toContainEqual({ id: 'money-register', sync: 66 });
    expect(placed).toContainEqual({ id: 'sting-bold-short', sync: 36 });
    expect(placed.some((p) => p.id.startsWith('whoosh') || p.id.startsWith('swish'))).toBe(false);
    expect(validateProject(project).ok).toBe(true);
  });

  it('motion graphics: price tag where the price is said, product lower-third, CTA pill — one at a time', () => {
    const style = stylePack('sale-fast');
    const cut = planJumpCuts({ startMs: plan.startMs, endMs: plan.endMs }, plan.words, speech, style.cuts);
    const frames = editFrames(source, plan, cut);
    const laid = (text: string) => ({ text, fontSize: 80, lines: 1 });
    const project = buildClipProject({
      projectId: '00000000-0000-4000-8000-0000000000aa',
      merchantId: '00000000-0000-4000-8000-0000000000bb',
      source,
      plan,
      pages: [
        {
          startFrame: 0,
          durationFrames: frames.durationFrames,
          words: frames.words.map(({ text, startFrame, endFrame }) => ({ text, startFrame, endFrame })),
          lines: [frames.words.map((_, i) => i)],
        },
      ],
      graphics: {
        prices: [{ frame: 66, text: laid('80 บาท') }],
        productName: laid('Liquid Blue'),
        cta: laid('กดตะกร้า'),
      },
      edit: { style, cut },
      seed: 'test',
    });
    expect(validateProject(project).ok).toBe(true);
    const gfxTrack = project.tracks.filter((t) => t.kind === 'overlay').at(-1);
    const els = (gfxTrack?.elementIds ?? []).map((id) => project.elements[id]);
    const shown = els.map((e) => (e?.type === 'text' ? [e.content, e.startFrame, e.durationFrames] : null));
    // product name right away (no hook here) for 2.5 s; the price at 66 overlaps it → the price tag starts only
    // when the frame is free (skipped here: 66 < 75); the CTA takes the last 2.5 s
    expect(shown).toEqual([
      ['Liquid Blue', 0, 75],
      ['กดตะกร้า', 75, 36],
    ]);
    // never two graphics at once
    const spans = els.map((e) => [e?.startFrame ?? 0, (e?.startFrame ?? 0) + (e?.durationFrames ?? 0)]);
    for (let i = 1; i < spans.length; i++)
      expect(spans[i]?.[0]).toBeGreaterThanOrEqual(spans[i - 1]?.[1] ?? 0);
    // a style without graphics adds none
    expect(build('simple').project.tracks.filter((t) => t.kind === 'overlay')).toHaveLength(0);
  });

  it('keeps every spoken word and suppresses a price graphic that duplicates its caption', () => {
    const style = stylePack('sale-fast');
    const cut = planJumpCuts({ startMs: plan.startMs, endMs: plan.endMs }, plan.words, speech, style.cuts);
    const frames = editFrames(source, plan, cut);
    const page = (from: number, to: number) => {
      const ws = frames.words.slice(from, to);
      const start = ws[0]?.startFrame ?? 0;
      const end = ws.at(-1)?.endFrame ?? 0;
      return {
        startFrame: start,
        durationFrames: end - start,
        words: ws.map((x) => ({
          text: x.text,
          startFrame: x.startFrame - start,
          endFrame: x.endFrame - start,
        })),
        lines: [ws.map((_, i) => i)],
      };
    };
    // page 1 "ตัวนี้สวย", page 2 "80บาทพิมพ์" (the price is said at 66)
    const pages = [page(0, 3), page(3, frames.words.length)];
    const project = buildClipProject({
      projectId: '00000000-0000-4000-8000-0000000000aa',
      merchantId: '00000000-0000-4000-8000-0000000000bb',
      source,
      plan,
      pages,
      graphics: { prices: [{ frame: 66, text: { text: '80 บาท', fontSize: 96, lines: 1 } }] },
      edit: { style, cut },
      seed: 'test',
    });
    expect(validateProject(project).ok).toBe(true);
    const captions = Object.values(project.elements).filter((e) => e.type === 'caption');
    expect(captions.map((c) => (c.type === 'caption' ? c.words.map((x) => x.text).join('') : ''))).toEqual([
      'ตัวนี้สวย',
      '80บาทพิมพ์',
    ]);
    const track = project.tracks.find((t) => t.kind === 'caption');
    expect(track?.elementIds).toEqual(captions.map((c) => c.id));
  });

  it('a piece shorter than a second keeps the framing before it (a re-frame that short reads as a glitch)', () => {
    const style = staticPack('sale-fast');
    // real case (S01a sale-fast): a 0.2-s piece between two removals, then a price 3 s later
    const segs = shotsOf([
      { frames: 84 },
      { frames: 6, gap: 20, words: ['80', 'บาท'] },
      { frames: 120, gap: 20 },
      { frames: 90, gap: 20, words: ['80', 'บาท'] },
      { frames: 600, gap: 20 },
    ]);
    const scales = segmentScales(style, segs);
    expect(scales[1]).toBe(scales[0]); // the 0.2-s piece never re-frames, even on a price
    expect(scales[3]).toBe(style.zoom.punchIn);
    expect(scales[4]).toBe(1);
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

  /** Shots laid end to end on the output; `gap` = source frames skipped before the shot (0 = continuous take). */
  function shotsOf(spec: { frames: number; gap?: number; words?: string[] }[]) {
    let out = 0;
    let src = 1000;
    return spec.map((s) => {
      src += s.gap ?? 0;
      const seg = { sourceInFrame: src, startFrame: out, durationFrames: s.frames, words: s.words ?? [] };
      out += s.frames;
      src += s.frames;
      return seg;
    });
  }
  const changes = (scales: number[], segs: { startFrame: number }[]) =>
    scales.flatMap((s, i) => (i > 0 && s !== scales[i - 1] ? [segs[i]?.startFrame ?? 0] : []));

  it('camera (user report "เด้งไปเด้งมา"): framing changes only at a jump cut, never within 2 s of the last', () => {
    const style = stylePack('sale-fast');
    const hold = CAMERA_RULES.holdSeconds * 30;
    // 12 jump cuts 1.5 s apart (real sale-fast rhythm on S01a), 30 fps → at most one change per `hold` frames
    const segs = shotsOf(
      Array.from({ length: 12 }, (_, i) => ({ frames: 45, gap: 30, words: i % 2 ? ['80', 'บาท'] : [] })),
    );
    const scales = segmentScales(style, segs);
    const at = changes(scales, segs);
    expect(at.length).toBeGreaterThan(0); // the rule limits zooms, it does not forbid them
    for (let i = 1; i < at.length; i++) expect((at[i] ?? 0) - (at[i - 1] ?? 0)).toBeGreaterThanOrEqual(hold);
    // a continuous take: a style without long-take re-frames never changes framing; one with them re-frames at
    // word starts, still at most once per `hold` (merchant 2026-11-13: one static shot looked like "captions only")
    const take = shotsOf([{ frames: 90 }, { frames: 90, gap: 0 }, { frames: 90, gap: 0 }]);
    expect(new Set(segmentScales(stylePack('simple'), take)).size).toBe(1);
    const reframed = segmentScales(style, take);
    expect(new Set(reframed).size).toBe(2);
    const taken = changes(reframed, take);
    for (let i = 1; i < taken.length; i++)
      expect((taken[i] ?? 0) - (taken[i - 1] ?? 0)).toBeGreaterThanOrEqual(hold);
  });

  it('camera: zoom share stays within the style energy budget, and always back to the base framing between two zooms', () => {
    const share = { calm: 0.2, gentle: 0.3, normal: 0.35, lively: 0.4, hype: 0.45 } as const;
    for (const id of STYLE_PACKS.map((s) => s.id)) {
      const style = stylePack(id);
      const segs = shotsOf(
        Array.from({ length: 20 }, (_, i) => ({
          frames: 60,
          gap: 20,
          words: i % 3 === 0 ? ['80', 'บาท'] : [],
        })),
      );
      const scales = segmentScales(style, segs);
      const total = segs.reduce((n, s) => n + s.durationFrames, 0);
      const zoomed = segs.reduce((n, s, i) => n + ((scales[i] ?? 1) > 1 ? s.durationFrames : 0), 0);
      expect(zoomed / total, id).toBeLessThanOrEqual(style.cuts.maxShotMs === null ? 0.2 : share[style.energy ?? 'normal']);
      expect(scales[0], id).toBe(1); // the hook shot is not cropped
      for (let i = 1; i < scales.length; i++) {
        const a = scales[i - 1] ?? 1;
        const b = scales[i] ?? 1;
        if (a !== b) expect(a === 1 || b === 1, `${id}: ${a} → ${b} jumps between two zooms`).toBe(true);
      }
    }
  });

  it('camera: a punch-in lands on a spoken price at a jump cut when the hold allows it', () => {
    const style = stylePack('sale-fast');
    const segs = shotsOf([
      { frames: 90 },
      { frames: 90, gap: 40, words: ['80', 'บาท'] },
      { frames: 300, gap: 40 },
    ]);
    const shots = segmentShots(style, segs);
    expect(shots.map((s) => s.scale)).toEqual([1, style.zoom.punchIn, 1]);
    expect(shots[1]?.punch).toBe('price');
  });

  it('price / call-to-action moments are marked even when the camera does not move (sound follows the words)', () => {
    const style = stylePack('sale-fast');
    // the price shot starts 1 s in: too soon for a re-frame, still a price moment
    const segs = shotsOf([{ frames: 30 }, { frames: 60, gap: 40, words: ['80', 'บาท'] }]);
    const shots = segmentShots(style, segs);
    expect(shots.map((s) => s.scale)).toEqual([1, 1]);
    expect(shots.map((s) => s.moment)).toEqual([null, 'price']);
  });

  it('segmentScales: no punch-in for a style without one', () => {
    expect(
      segmentScales(stylePack('premium'), [
        { sourceInFrame: 0, startFrame: 0, durationFrames: 10, words: ['80', 'บาท'] },
      ]),
    ).toEqual([1]);
  });
});
