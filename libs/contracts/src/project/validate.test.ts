import { describe, expect, it } from 'vitest';
import s01Clip from './fixtures/s01-clip.project.json' with { type: 'json' };
import type { Project } from './schema.js';
import { validateProject } from './validate.js';

const U = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const SRC = U(900);
const ASSET = U(901);
const T_VIDEO = U(1);
const T_CAP = U(2);
const T_OVER = U(3);
const V1 = U(11);
const V2 = U(12);
const C1 = U(21);
const X1 = U(31);

const transform = { x: 0, y: 0, scale: 1, rotation: 0 };

/** A small valid 9:16 clip: two video pieces, one caption, one text (built in-test so each case mutates a copy). */
function base(): Project {
  return {
    schemaVersion: 1,
    id: U(100),
    merchantId: U(200),
    fps: { num: 30, den: 1 },
    width: 1080,
    height: 1920,
    durationFrames: 300,
    assets: {
      [ASSET]: {
        sourceId: SRC,
        kind: 'video',
        durationFrames: 81_000,
        hasAudio: true,
        width: 406,
        height: 720,
      },
    },
    tracks: [
      { id: T_VIDEO, kind: 'video', elementIds: [V1, V2] },
      { id: T_CAP, kind: 'caption', elementIds: [C1] },
      { id: T_OVER, kind: 'overlay', elementIds: [X1] },
    ],
    elements: {
      [V1]: {
        type: 'video',
        id: V1,
        trackId: T_VIDEO,
        startFrame: 0,
        durationFrames: 150,
        origin: 'ai',
        assetId: ASSET,
        sourceInFrame: 18_000,
        playbackRate: 1,
        volume: 1,
        transform,
        fit: 'cover',
      },
      [V2]: {
        type: 'video',
        id: V2,
        trackId: T_VIDEO,
        startFrame: 150,
        durationFrames: 150,
        origin: 'ai',
        assetId: ASSET,
        sourceInFrame: 20_000,
        playbackRate: 1,
        volume: 1,
        transform,
        fit: 'cover',
      },
      [C1]: {
        type: 'caption',
        id: C1,
        trackId: T_CAP,
        startFrame: 0,
        durationFrames: 90,
        origin: 'ai',
        // real words from the S01 transcript ("ตัวนี้ 62 ยาว 27 นะ")
        words: [
          { text: 'ตัวนี้', startFrame: 0, endFrame: 20 },
          { text: '62', startFrame: 20, endFrame: 32 },
          { text: 'ยาว', startFrame: 32, endFrame: 47 },
          { text: '27', startFrame: 47, endFrame: 65 },
          { text: 'นะ', startFrame: 65, endFrame: 83 },
        ],
        lines: [
          [0, 1, 2],
          [3, 4],
        ],
        styleRef: 'bold-highlight',
        transform: { x: 0, y: 600, scale: 1, rotation: 0 },
      },
      [X1]: {
        type: 'text',
        id: X1,
        trackId: T_OVER,
        startFrame: 0,
        durationFrames: 60,
        origin: 'user',
        content: 'เสื้อมัดย้อม',
        styleRef: 'title',
        transform: { x: 0, y: -700, scale: 1, rotation: 0 },
      },
    },
    meta: { createdBy: 'ai' },
  };
}

type Mut = (p: Project) => void;
const el = (p: Project, id: string) => p.elements[id] as Record<string, unknown>;

describe('validateProject', () => {
  it('accepts a valid project', () => {
    const r = validateProject(base());
    expect(r).toEqual({ ok: true, project: base() });
  });

  it('accepts brand tokens (colours, font) and the brand logo asset (E08-F08)', () => {
    const p = base();
    const x = el(p, X1);
    x.style = {
      fontFamily: 'brand',
      fontWeight: 800,
      fontSize: 72,
      color: 'brand:text',
      background: 'brand:primary',
      align: 'center',
    };
    p.assets[U(903)] = { brandLogo: true, kind: 'image', durationFrames: 300, hasAudio: false };
    expect(validateProject(p).ok).toBe(true);
    (x.style as Record<string, unknown>).color = 'brand:pink';
    expect(validateProject(p).ok).toBe(false);
  });

  const cases: [string, Mut, { code: string; path: string; message: RegExp }][] = [
    [
      'asset with neither sourceId nor libraryId',
      (p) => {
        delete p.assets[ASSET]!.sourceId;
      },
      {
        code: 'asset_ref',
        path: `assets.${ASSET}`,
        message: /exactly one of sourceId, libraryId or brandLogo/,
      },
    ],
    [
      'asset with both sourceId and libraryId',
      (p) => {
        p.assets[ASSET]!.libraryId = 'pop-small-in';
      },
      { code: 'asset_ref', path: `assets.${ASSET}`, message: /exactly one/ },
    ],
    [
      'unknown library sound',
      (p) => {
        p.assets[U(902)] = { libraryId: 'laser-gun', kind: 'audio', durationFrames: 10, hasAudio: true };
      },
      { code: 'library_asset', path: `assets.${U(902)}.libraryId`, message: /laser-gun does not exist/ },
    ],
    [
      'library asset that is not audio',
      (p) => {
        p.assets[U(902)] = { libraryId: 'pop-small-in', kind: 'image', durationFrames: 10, hasAudio: false };
      },
      { code: 'library_asset', path: `assets.${U(902)}.kind`, message: /must be audio/ },
    ],
    [
      'schema: fractional frame',
      (p) => {
        el(p, V1).durationFrames = 1.5;
      },
      { code: 'schema', path: `elements.${V1}.durationFrames`, message: /expected int/i },
    ],
    [
      'schema: unknown element type',
      (p) => {
        el(p, X1).type = 'sticker';
      },
      { code: 'schema', path: `elements.${X1}.type`, message: /.+/ },
    ],
    [
      'element stored under another key',
      (p) => {
        el(p, V2).id = U(99);
      },
      { code: 'id_mismatch', path: `elements.${V2}.id`, message: /stored under/ },
    ],
    [
      'element on a track that does not exist',
      (p) => {
        el(p, X1).trackId = U(77);
        p.tracks = p.tracks.filter((t) => t.id !== T_OVER);
      },
      { code: 'unknown_track', path: `elements.${X1}.trackId`, message: new RegExp(`track ${U(77)}`) },
    ],
    [
      'element not listed by its track',
      (p) => {
        p.tracks[0]!.elementIds = [V1];
      },
      { code: 'track_membership', path: `elements.${V2}`, message: /not listed/ },
    ],
    [
      'track lists a missing element',
      (p) => {
        p.tracks[2]!.elementIds.push(U(55));
      },
      { code: 'unknown_element', path: 'tracks.2.elementIds.1', message: /does not exist/ },
    ],
    [
      'element listed twice',
      (p) => {
        p.tracks[0]!.elementIds.push(V1);
      },
      { code: 'track_membership', path: 'tracks.0.elementIds.2', message: /more than once/ },
    ],
    [
      'audio element on a video track',
      (p) => {
        const v = el(p, V2);
        v.type = 'audio';
        delete v.transform;
        delete v.fit;
      },
      { code: 'track_kind', path: `elements.${V2}`, message: /audio element .* video track/ },
    ],
    [
      'element past the end of the project',
      (p) => {
        el(p, V2).durationFrames = 151;
      },
      { code: 'out_of_bounds', path: `elements.${V2}`, message: /ends at frame 301.*300 frames/ },
    ],
    [
      'two elements overlap on one track',
      (p) => {
        el(p, V2).startFrame = 149;
        el(p, V2).durationFrames = 150;
      },
      { code: 'overlap', path: `elements.${V2}`, message: new RegExp(`overlaps ${V1} .*frames 149–149`) },
    ],
    [
      'media element uses a missing asset',
      (p) => {
        el(p, V1).assetId = U(66);
      },
      { code: 'missing_asset', path: `elements.${V1}.assetId`, message: /not in project assets/ },
    ],
    [
      'audio from an asset without audio',
      (p) => {
        p.assets[ASSET]!.hasAudio = false;
        p.tracks.push({ id: U(4), kind: 'audio', elementIds: [U(41)] });
        p.elements[U(41)] = {
          type: 'audio',
          id: U(41),
          trackId: U(4),
          startFrame: 0,
          durationFrames: 30,
          origin: 'user',
          assetId: ASSET,
          sourceInFrame: 0,
          playbackRate: 1,
          volume: 1,
        };
      },
      { code: 'asset_kind', path: `elements.${U(41)}.assetId`, message: /has no audio/ },
    ],
    [
      'source range past the end of the asset',
      (p) => {
        el(p, V2).sourceInFrame = 80_900;
      },
      {
        code: 'source_range',
        path: `elements.${V2}.sourceInFrame`,
        message: /needs asset frames 80900–81049.*81000/,
      },
    ],
    [
      'caption word with no length',
      (p) => {
        (el(p, C1).words as { endFrame: number }[])[1]!.endFrame = 20;
      },
      { code: 'caption_word', path: `elements.${C1}.words.1`, message: /ends at or before it starts/ },
    ],
    [
      'caption words out of order',
      (p) => {
        (el(p, C1).words as { startFrame: number }[])[2]!.startFrame = 25;
      },
      { code: 'caption_order', path: `elements.${C1}.words.2`, message: /starts before word 1 ends/ },
    ],
    [
      'caption word after the caption ends',
      (p) => {
        (el(p, C1).words as { endFrame: number }[])[4]!.endFrame = 91;
      },
      { code: 'caption_bounds', path: `elements.${C1}.words.4`, message: /after the caption ends \(90\)/ },
    ],
    [
      'caption lines skip a word',
      (p) => {
        el(p, C1).lines = [
          [0, 1],
          [3, 4],
        ];
      },
      { code: 'caption_lines', path: `elements.${C1}.lines`, message: /every word once, in order/ },
    ],
    [
      'text without a style',
      (p) => {
        delete el(p, X1).styleRef;
      },
      { code: 'text_style', path: `elements.${X1}`, message: /style or styleRef/ },
    ],
    [
      'keyframe outside the element',
      (p) => {
        el(p, X1).keyframes = { opacity: [{ frame: 61, value: 0, easing: 'linear' }] };
      },
      {
        code: 'keyframe_bounds',
        path: `elements.${X1}.keyframes.opacity.0`,
        message: /frame 61 is outside the element \(60 frames\)/,
      },
    ],
    [
      'duplicate track id',
      (p) => {
        p.tracks[2]!.id = T_CAP;
        el(p, X1).trackId = T_CAP;
      },
      { code: 'duplicate_track', path: 'tracks.2.id', message: /used twice/ },
    ],
  ];

  it.each(cases)('rejects: %s', (_name, mutate, expected) => {
    const p = structuredClone(base());
    mutate(p);
    const r = validateProject(p);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toContainEqual(
      expect.objectContaining({
        code: expected.code,
        path: expected.path,
        message: expect.stringMatching(expected.message),
      }),
    );
  });

  it('accepts the fixture built from real S01 metadata + transcript', () => {
    const r = validateProject(s01Clip);
    if (!r.ok) throw new Error(JSON.stringify(r.errors.slice(0, 3)));
    const captions = Object.values(r.project.elements).filter((e) => e.type === 'caption');
    expect(captions).toHaveLength(13);
    // sizes stay whole tokens ("อบ 21.5 ยา 28.5 นะ" in the real transcript)
    expect(captions.flatMap((c) => (c.type === 'caption' ? c.words.map((w) => w.text) : []))).toContain(
      '21.5',
    );
  });

  it('accepts a library sound on an audio track (no sourceId)', () => {
    const p = base();
    const sound = U(903);
    const track = U(4);
    p.assets[sound] = { libraryId: 'whoosh-fast-soft', kind: 'audio', durationFrames: 7, hasAudio: true };
    p.tracks.push({ id: track, kind: 'audio', elementIds: [U(41)] });
    p.elements[U(41)] = {
      type: 'audio',
      id: U(41),
      trackId: track,
      startFrame: 27,
      durationFrames: 7,
      origin: 'ai',
      assetId: sound,
      sourceInFrame: 0,
      playbackRate: 1,
      volume: 0.79,
    };
    const r = validateProject(p);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
  });

  it('frame maths stay exact at 29.97 fps over 2 hours', () => {
    const p = base();
    p.fps = { num: 30000, den: 1001 };
    p.durationFrames = 215_784; // 2 h at 29.97
    el(p, V2).durationFrames = 215_784 - 150;
    p.assets[ASSET]!.durationFrames = 300_000;
    expect(validateProject(p).ok).toBe(true);
  });
});
