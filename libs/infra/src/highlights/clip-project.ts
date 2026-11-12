import { createHash } from 'node:crypto';
import {
  type LibrarySound,
  librarySound,
  type Project,
  type StylePack,
  stylePack,
  validateProject,
} from '@myvideo/contracts';
import type { LaidOutText, LayoutWord, StageTextLayout } from '../render/text-layout.js';
import { type EmphasisPage, markEmphasis, priceMentions } from './clip-graphics.js';
import { type JumpCutPlan, keyMomentKind, planJumpCuts, type SpanMs, splitLongShots } from './jump-cuts.js';
import { placeSoundEffects, type SfxMoment, soundFrames } from './sound-effects.js';

/**
 * Clip plan → Project JSON (E07-F07): deterministic. One 9:16 `cover` video element (centre crop; the reframe
 * offset is the element's `transform.x`, 0 = centre, adjustable by the user), caption pages from the transcript
 * words (laid out by the stage's own builder + font), and the hook as a text element on an overlay track for the
 * first seconds. Every element is `origin: 'ai'` and `meta.createdBy = 'ai'`: the workflow made it, the user
 * did not; the user's later edits create new versions (ARCHITECTURE §6).
 */
export const CLIP_WIDTH = 1080;
export const CLIP_HEIGHT = 1920;
export const CLIP_CAPTION_STYLE = 'bold-highlight' as const;
/** Lower safe area, same as clips the user creates by hand (E05-F07). */
const CAPTION_Y = 520;
/** Upper area for the hook. */
const HOOK_Y = -520;
const HOOK_SECONDS = 3;
/** Text boxes hug their text with padding (stage): 760 px of text stays inside the 920-px text area. */
const HOOK_STYLE = { fontWeight: 800, fontSizes: [88, 76, 64, 56], maxWidth: 760, maxLines: 2 };
/**
 * Share of a zoom's top crop given back by moving the picture down (0 = zoom on the centre, 1 = top edge fixed).
 * Seen on S01a: a centred 1.28× punch-in cut the seller's eyes off; 0.7 keeps the face, the frame stays covered.
 */
const ZOOM_KEEP_TOP = 0.7;
/** Centred mid-frame, where platforms put their button column on the right 15 %: lines stay within 162–918 px. */
const END_CARD_STYLE = { fontWeight: 800, fontSizes: [80, 68, 56], maxWidth: 680, maxLines: 2 };
const PRICE_TAG_STYLE = { fontWeight: 900, fontSizes: [96, 84, 72], maxWidth: 560, maxLines: 1 };
/** End card centre (canvas px above the middle) when a CTA pill follows it below (pack `graphics.cta.y`). */
const END_CARD_LIFT = -150;
const CTA_STYLE = { fontWeight: 800, fontSizes: [72, 64, 56], maxWidth: 620, maxLines: 1 };
const PRODUCT_NAME_STYLE = { fontWeight: 700, fontSizes: [56, 48, 40], maxWidth: 620, maxLines: 1 };

export type ClipSourceInfo = {
  sourceId: string;
  fps: { num: number; den: number };
  durationFrames: number;
  hasAudio: boolean;
};
export type ClipWordMs = { text: string; startMs: number; endMs: number; origin?: 'ai'; asrText?: string };
export type ClipPlan = {
  /** Cut on the source timeline (ms), already snapped to word boundaries (F04). */
  startMs: number;
  endMs: number;
  /** Transcript words inside the cut (ms on the source timeline). */
  words: ClipWordMs[];
  title: string;
  hook?: { text: string; origin: 'ai' | 'rules' };
};

/** Deterministic UUID (version-8 layout) from a seed: rebuilding the same plan gives the same ids. */
export function seededIds(seed: string): () => string {
  let n = 0;
  return () => {
    const h = createHash('sha256').update(`${seed}:${n++}`).digest('hex');
    const variant = ((Number.parseInt(h[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
}

const toFrame = (ms: number, fps: { num: number; den: number }) =>
  Math.round((ms * fps.num) / (1000 * fps.den));

/** A caption word on the output timeline; `asrText` marks an AI spelling correction (kept for undo). */
export type TimedWord = LayoutWord & { asrText?: string };

/** Clip range in source frames and the words in clip-relative frames (what the caption builder takes). */
export function clipFrames(source: ClipSourceInfo, plan: ClipPlan) {
  const sourceInFrame = Math.max(0, Math.floor((plan.startMs * source.fps.num) / (1000 * source.fps.den)));
  const end = Math.min(
    source.durationFrames,
    Math.ceil((plan.endMs * source.fps.num) / (1000 * source.fps.den)),
  );
  const durationFrames = Math.max(1, end - sourceInFrame);
  const words: TimedWord[] = plan.words
    .map((w) => ({
      text: w.text.trim(),
      startFrame: Math.max(0, toFrame(w.startMs, source.fps) - sourceInFrame),
      endFrame: Math.min(durationFrames, toFrame(w.endMs, source.fps) - sourceInFrame),
      ...(w.asrText !== undefined ? { asrText: w.asrText } : {}),
    }))
    .filter((w) => w.text.length > 0 && w.endFrame > w.startFrame);
  return { sourceInFrame, durationFrames, words };
}

export type EditSegmentFrames = {
  sourceInFrame: number;
  /** Start on the output (project) timeline. */
  startFrame: number;
  durationFrames: number;
  /** Words whose start falls in this segment (for key-moment zoom). */
  words: string[];
};

/**
 * Jump-cut plan → kept segments back to back on the output timeline, and caption words moved onto it (frames).
 * Segment lengths are whole frames and contiguous; a word maps through the same segment arithmetic, so a
 * caption never drifts from the picture by more than the rounding of its own segment.
 */
export function editFrames(source: ClipSourceInfo, plan: ClipPlan, cut: JumpCutPlan) {
  const segments: EditSegmentFrames[] = [];
  let out = 0;
  for (const s of cut.segments) {
    // same rounding at both ends: contiguous pieces (zoom cuts) share a boundary frame, never repeat or skip one
    const sourceInFrame = Math.max(0, toFrame(s.startMs, source.fps));
    const end = Math.min(source.durationFrames, toFrame(s.endMs, source.fps));
    const durationFrames = end - sourceInFrame;
    if (durationFrames < 1) continue;
    segments.push({ sourceInFrame, startFrame: out, durationFrames, words: [] });
    out += durationFrames;
  }
  if (segments.length === 0) {
    const f = clipFrames(source, plan);
    return {
      durationFrames: f.durationFrames,
      segments: [
        { sourceInFrame: f.sourceInFrame, startFrame: 0, durationFrames: f.durationFrames, words: [] },
      ],
      words: f.words,
    };
  }
  const durationFrames = out;
  const toOut = (ms: number) => {
    const f = toFrame(ms, source.fps);
    let seg = segments[0] as EditSegmentFrames;
    for (const s of segments) if (f >= s.sourceInFrame) seg = s;
    const local = Math.min(Math.max(f - seg.sourceInFrame, 0), seg.durationFrames);
    return { frame: seg.startFrame + local, seg };
  };
  const words: TimedWord[] = [];
  for (const w of cut.words) {
    const a = toOut(w.startMs);
    const b = toOut(w.endMs);
    const text = w.text.trim();
    const startFrame = Math.min(a.frame, durationFrames);
    const endFrame = Math.min(Math.max(b.frame, startFrame), durationFrames);
    if (!text || endFrame <= startFrame) continue;
    words.push({ text, startFrame, endFrame, ...(w.asrText !== undefined ? { asrText: w.asrText } : {}) });
    a.seg.words.push(text);
  }
  return { durationFrames, segments, words };
}

/**
 * Scale per shot: the style's cycle, or its punch-in where a price / call to action is spoken — never on two shots
 * in a row (a punch-in that never lets go stops meaning "this matters").
 */
export function segmentScales(
  style: StylePack,
  segments: readonly EditSegmentFrames[],
  minFrames = 30,
): number[] {
  return segmentShots(style, segments, minFrames).map((s) => s.scale);
}

/** Scale per shot plus which key moment (price / call to action) a punch-in shot marks. */
export function segmentShots(
  style: StylePack,
  segments: readonly EditSegmentFrames[],
  /** Shorter pieces keep the previous framing (≈ 1 s). */
  minFrames = 30,
): { scale: number; punch: 'price' | 'cta' | null }[] {
  const cycle = style.zoom.cycle.length > 0 ? style.zoom.cycle : [1];
  // shots since the last punch-in: a punch-in only means "this matters" when it is rare
  let since = Number.POSITIVE_INFINITY;
  let framing = 0;
  let previous: { scale: number; punch: 'price' | 'cta' | null } | undefined;
  return segments.map((s) => {
    // a piece under a second keeps the framing before it: a re-frame that short reads as a glitch
    if (previous && s.durationFrames < minFrames) {
      since++;
      return { scale: previous.scale, punch: null };
    }
    const kind =
      style.zoom.punchIn !== null && since >= Math.max(1, style.zoom.punchGap)
        ? keyMomentKind(s.words)
        : null;
    since = kind !== null ? 1 : since + 1;
    previous = kind
      ? { scale: style.zoom.punchIn as number, punch: kind }
      : { scale: cycle[framing++ % cycle.length] ?? 1, punch: null };
    return previous;
  });
}

/** Pure: plan + laid-out captions/hook → a Project (id/merchant set by the caller's insert). */
export function buildClipProject(input: {
  projectId: string;
  merchantId: string;
  workflowRunId?: string;
  source: ClipSourceInfo;
  plan: ClipPlan;
  pages: EmphasisPage[];
  hook?: LaidOutText;
  /** Title laid out for the closing card (style packs with an end card). */
  endCard?: LaidOutText;
  /** Motion graphics laid out with the stage font (style packs that have them). */
  graphics?: {
    prices: { frame: number; text: LaidOutText }[];
    productName?: LaidOutText;
    /** The style's call-to-action label (a fixed instruction, not a product claim). */
    cta?: LaidOutText;
  };
  /** Style pack + jump-cut plan. Absent = the plain cut: one video element, default captions. */
  edit?: { style: StylePack; cut: JumpCutPlan };
  seed: string;
}): Project {
  const { source, plan, pages, hook, edit } = input;
  const newId = seededIds(input.seed);
  const frames = edit ? editFrames(source, plan, edit.cut) : undefined;
  const plain = clipFrames(source, plan);
  const durationFrames = frames?.durationFrames ?? plain.durationFrames;
  const segments = frames?.segments ?? [
    { sourceInFrame: plain.sourceInFrame, startFrame: 0, durationFrames, words: [] },
  ];
  const shots = edit
    ? segmentShots(edit.style, segments, Math.round(source.fps.num / source.fps.den))
    : segments.map(() => ({ scale: 1, punch: null as 'price' | 'cta' | null }));
  const scales = shots.map((s) => s.scale);
  const assetId = newId();
  const videoTrack = newId();
  const captionTrack = newId();
  const overlayTrack = newId();
  const transform = (y: number, scale = 1) => ({ x: 0, y, scale, rotation: 0 });
  const elements: Project['elements'] = {};
  const drift = edit?.style.zoom.drift ?? 0;
  const videoIds = segments.map((seg, i) => {
    const id = newId();
    const scale = scales[i] ?? 1;
    // one-way push-in over the segment (never back out inside a shot); rounded to keep the JSON readable
    const pushed = Math.round(scale * (1 + drift) * 10_000) / 10_000;
    elements[id] = {
      ...(drift > 0 && seg.durationFrames > 1
        ? {
            keyframes: {
              'transform.scale': [
                { frame: 0, value: scale, easing: 'linear' as const },
                { frame: seg.durationFrames - 1, value: pushed, easing: 'linear' as const },
              ],
            },
          }
        : {}),
      type: 'video',
      id,
      trackId: videoTrack,
      startFrame: seg.startFrame,
      durationFrames: seg.durationFrames,
      origin: 'ai',
      assetId,
      sourceInFrame: seg.sourceInFrame,
      playbackRate: 1,
      volume: 1,
      // zoomed shots keep the top (the seller's face): most of the extra crop comes off the bottom
      transform: transform(Math.round((scale - 1) * (CLIP_HEIGHT / 2) * ZOOM_KEEP_TOP), scale),
      fit: 'cover',
    };
    return id;
  });
  const captionStyle = edit?.style.captions.styleRef ?? CLIP_CAPTION_STYLE;
  const captionY = edit?.style.captions.y ?? CAPTION_Y;
  const corrected = (frames?.words ?? plain.words).filter((w) => w.asrText !== undefined);
  const captionIds = pages
    .filter((p) => p.startFrame < durationFrames)
    .map((p) => {
      const id = newId();
      elements[id] = {
        type: 'caption',
        id,
        trackId: captionTrack,
        startFrame: p.startFrame,
        durationFrames: Math.max(1, Math.min(p.durationFrames, durationFrames - p.startFrame)),
        origin: 'ai',
        // Layout may discard extra fields. Reattach provenance by text + absolute frame bounds,
        // not by text alone (the same spoken word can occur repeatedly on different pages).
        words: p.words.map((word) => {
          const original = corrected.find(
            (w) =>
              w.text === word.text &&
              w.startFrame === p.startFrame + word.startFrame &&
              w.endFrame === p.startFrame + word.endFrame,
          );
          return {
            text: word.text,
            startFrame: word.startFrame,
            endFrame: word.endFrame,
            ...(original?.asrText !== undefined ? { origin: 'ai' as const, asrText: original.asrText } : {}),
            ...(word.emphasis ? { emphasis: true as const } : {}),
          };
        }),
        lines: p.lines,
        styleRef: captionStyle,
        transform: transform(captionY),
      };
      return id;
    });
  const overlayIds: string[] = [];
  const fps = source.fps.num / source.fps.den;
  let hookEnd = 0;
  if (input.plan.hook && hook) {
    const id = newId();
    const h = edit?.style.hook;
    hookEnd = Math.min(durationFrames, Math.round((h?.seconds ?? HOOK_SECONDS) * fps));
    elements[id] = {
      type: 'text',
      id,
      trackId: overlayTrack,
      startFrame: 0,
      durationFrames: hookEnd,
      origin: 'ai',
      content: hook.text,
      style: {
        fontFamily: 'Noto Sans Thai Variable',
        fontWeight: h?.fontWeight ?? HOOK_STYLE.fontWeight,
        fontSize: hook.fontSize,
        color: h?.color ?? '#ffffff',
        ...(h ? (h.background ? { background: h.background } : {}) : { background: '#000000aa' }),
        align: 'center',
      },
      transform: transform(h?.y ?? HOOK_Y),
      animationIn: { presetId: h?.animationIn ?? 'pop', durationFrames: Math.min(12, hookEnd) },
    };
    overlayIds.push(id);
  }
  const end = edit?.style.endCard;
  let endCardStart: number | undefined;
  if (end && input.endCard) {
    // closing card over the last seconds of the picture, never over the opening title
    const cardFrames = Math.round(end.seconds * fps);
    const startFrame = Math.max(hookEnd, durationFrames - cardFrames);
    if (durationFrames - startFrame >= Math.round(fps)) {
      endCardStart = startFrame;
      const id = newId();
      elements[id] = {
        type: 'text',
        id,
        trackId: overlayTrack,
        startFrame,
        durationFrames: durationFrames - startFrame,
        origin: 'ai',
        content: input.endCard.text,
        style: {
          fontFamily: 'Noto Sans Thai Variable',
          fontWeight: END_CARD_STYLE.fontWeight,
          fontSize: input.endCard.fontSize,
          color: end.color,
          background: end.background,
          align: 'center',
        },
        // a call-to-action pill sits under the card: lift the card so the two never overlap
        transform: transform(edit?.style.graphics.cta && input.graphics?.cta ? END_CARD_LIFT : 0),
        animationIn: { presetId: end.animationIn, durationFrames: Math.min(12, durationFrames - startFrame) },
      };
      overlayIds.push(id);
    }
  }

  // motion graphics (E07-F14): one at a time, on their own overlay track, never over the hook
  const graphicIds: string[] = [];
  const graphicsTrack = newId();
  const gfx = edit?.style.graphics;
  const closingFrom = endCardStart ?? durationFrames;
  const textEl = (
    content: LaidOutText,
    startFrame: number,
    frames: number,
    look: { color: string; background: string; animationIn: string; y: number },
    fontWeight: number,
  ) => {
    const id = newId();
    elements[id] = {
      type: 'text',
      id,
      trackId: graphicsTrack,
      startFrame,
      durationFrames: frames,
      origin: 'ai',
      content: content.text,
      style: {
        fontFamily: 'Noto Sans Thai Variable',
        fontWeight,
        fontSize: content.fontSize,
        color: look.color,
        background: look.background,
        align: 'center',
      },
      transform: transform(look.y),
      animationIn: { presetId: look.animationIn, durationFrames: Math.min(9, frames) },
      animationOut: { presetId: 'fade', durationFrames: Math.min(6, frames) },
    };
    graphicIds.push(id);
  };
  let graphicsFree = hookEnd;
  if (gfx?.productName && input.graphics?.productName) {
    const frames = Math.min(Math.round(2.5 * fps), closingFrom - hookEnd);
    if (frames >= Math.round(fps)) {
      textEl(input.graphics.productName, hookEnd, frames, gfx.productName, 700);
      graphicsFree = hookEnd + frames;
    }
  }
  if (gfx?.priceTag) {
    for (const p of input.graphics?.prices ?? []) {
      if (p.frame < graphicsFree) continue;
      const frames = Math.min(Math.round(2 * fps), closingFrom - p.frame);
      if (frames < Math.round(fps)) continue;
      textEl(p.text, p.frame, frames, gfx.priceTag, 900);
      graphicsFree = p.frame + frames;
      // the tag IS the caption for that moment: drop caption pages saying the same price under it (user review
      // 2026-11-12: "1,500 บาท" tag right above the caption "1,500 บาทค่ะ")
      const digits = p.text.text.replace(/[^\d]/g, '');
      for (const cid of captionIds) {
        const c = elements[cid];
        if (c?.type !== 'caption') continue;
        const overlaps = c.startFrame < p.frame + frames && c.startFrame + c.durationFrames > p.frame;
        const said = c.words
          .map((w) => w.text)
          .join('')
          .replace(/[^\d]/g, '');
        if (overlaps && digits && said.includes(digits)) delete elements[cid];
      }
    }
  }
  if (gfx?.cta && input.graphics?.cta) {
    const startFrame = Math.max(graphicsFree, endCardStart ?? durationFrames - Math.round(2.5 * fps));
    const frames = durationFrames - startFrame;
    if (frames >= Math.round(fps)) {
      textEl(
        input.graphics.cta,
        startFrame,
        frames,
        { color: '#111111', background: '#ffffff', animationIn: gfx.cta.animationIn, y: gfx.cta.y },
        800,
      );
    }
  }

  // sound effects (D-026): created last so the ids above stay what they were before sounds existed
  const assets: Project['assets'] = {
    [assetId]: {
      sourceId: source.sourceId,
      kind: 'video',
      durationFrames: source.durationFrames,
      hasAudio: source.hasAudio,
    },
  };
  const audioTracks: Project['tracks'] = [];
  if (edit?.style.sfx) {
    const moments: SfxMoment[] = [];
    if (hookEnd > 0) moments.push({ frame: 0, kind: 'hook' });
    // no shot-change sound in the half second before / during the closing card: the card has its own
    const cutsUntil = endCardStart === undefined ? durationFrames : endCardStart - Math.round(fps / 2);
    let prices = 0;
    segments.forEach((seg, i) => {
      const punch = shots[i]?.punch ?? null;
      if (punch === 'price') {
        // a price sound only means something the first time or two
        if (prices < (edit.style.sfx?.maxPrice ?? 0)) moments.push({ frame: seg.startFrame, kind: 'price' });
        prices++;
      } else if (punch) moments.push({ frame: seg.startFrame, kind: punch });
      else if (i > 0 && seg.startFrame < cutsUntil && (edit.style.sfx?.cut.length ?? 0) > 0)
        moments.push({ frame: seg.startFrame, kind: 'cut' });
    });
    if (endCardStart !== undefined) moments.push({ frame: endCardStart, kind: 'endCard' });
    const placed = placeSoundEffects(edit.style.sfx, moments, { fps: source.fps, durationFrames });
    const soundAssets = new Map<string, string>();
    const trackIds: string[] = [];
    const trackElements: string[][] = [];
    for (const s of placed) {
      let soundAsset = soundAssets.get(s.soundId);
      if (!soundAsset) {
        soundAsset = newId();
        soundAssets.set(s.soundId, soundAsset);
        const sound = librarySound(s.soundId) as LibrarySound;
        assets[soundAsset] = {
          libraryId: s.soundId,
          kind: 'audio',
          durationFrames: soundFrames(sound.durationSec, source.fps),
          hasAudio: true,
        };
      }
      if (!trackIds[s.track]) {
        trackIds[s.track] = newId();
        trackElements[s.track] = [];
      }
      const id = newId();
      elements[id] = {
        type: 'audio',
        id,
        trackId: trackIds[s.track] as string,
        startFrame: s.startFrame,
        durationFrames: s.durationFrames,
        origin: 'ai',
        assetId: soundAsset,
        sourceInFrame: s.sourceInFrame,
        playbackRate: 1,
        volume: s.volume,
      };
      trackElements[s.track]?.push(id);
    }
    trackIds.forEach((tid, i) => {
      if (tid) audioTracks.push({ id: tid, kind: 'audio', elementIds: trackElements[i] ?? [] });
    });
  }
  return {
    schemaVersion: 1,
    id: input.projectId,
    merchantId: input.merchantId,
    fps: { num: source.fps.num, den: source.fps.den },
    width: CLIP_WIDTH,
    height: CLIP_HEIGHT,
    durationFrames,
    assets,
    tracks: [
      { id: videoTrack, kind: 'video', elementIds: videoIds },
      { id: captionTrack, kind: 'caption', elementIds: captionIds.filter((id) => elements[id]) },
      ...(overlayIds.length > 0
        ? [{ id: overlayTrack, kind: 'overlay' as const, elementIds: overlayIds }]
        : []),
      ...(graphicIds.length > 0
        ? [{ id: graphicsTrack, kind: 'overlay' as const, elementIds: graphicIds }]
        : []),
      ...audioTracks,
    ],
    elements,
    meta: {
      createdBy: 'ai',
      ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
      title: plan.title.slice(0, 200),
      ...(edit ? { styleId: edit.style.id } : {}),
    },
  } as Project;
}

export class InvalidClipProjectError extends Error {
  constructor(readonly issues: { path: string; message: string }[]) {
    super(`built clip project is invalid: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
    this.name = 'InvalidClipProjectError';
  }
}

/**
 * Lays out captions + hook (+ end card) with the stage, builds and validates the project. With `style`, the clip is
 * edited by that style pack: jump cuts on the VAD `speech` spans (source ms) and filler words, zoom per segment,
 * the pack's caption look, title and closing card. Without it: the plain cut.
 */
export async function layoutClipProject(
  layout: StageTextLayout,
  input: Omit<Parameters<typeof buildClipProject>[0], 'pages' | 'hook' | 'endCard' | 'edit' | 'graphics'> & {
    style?: { styleId?: string; speech: readonly SpanMs[] };
    /** The merchant's product name (lower-third, emphasis) — only what the merchant typed. */
    productName?: string;
  },
): Promise<Project> {
  const { style: styleInput, productName, ...rest } = input;
  let edit: { style: StylePack; cut: JumpCutPlan } | undefined;
  if (styleInput) {
    const style = stylePack(styleInput.styleId);
    const jump = planJumpCuts(
      { startMs: input.plan.startMs, endMs: input.plan.endMs },
      input.plan.words,
      styleInput.speech,
      style.cuts,
    );
    // zoom cuts only re-frame: the kept time (and so the output mapping) is unchanged
    const cut = { ...jump, segments: splitLongShots(jump.segments, jump.words, style.cuts.maxShotMs) };
    edit = { style, cut };
  }
  const words = edit
    ? editFrames(input.source, input.plan, edit.cut).words
    : clipFrames(input.source, input.plan).words;
  const captionStyle = edit?.style.captions.styleRef ?? CLIP_CAPTION_STYLE;
  const capt = edit?.style.captions;
  const laid =
    words.length > 0
      ? await layout.layoutCaptions(
          words.map(({ text, startFrame, endFrame }) => ({ text, startFrame, endFrame })),
          {
            styleRef: captionStyle,
            canvasWidth: CLIP_WIDTH,
            maxLines: capt?.maxLines ?? 2,
            ...(capt?.maxWords ? { maxWords: capt.maxWords } : {}),
          },
        )
      : [];
  // short-form pages get one key word each; the classic 2-line look stays plain
  const pages: EmphasisPage[] = capt?.maxWords ? markEmphasis(laid, productName ? [productName] : []) : laid;
  const hook = input.plan.hook ? await layout.layoutText(input.plan.hook.text, HOOK_STYLE) : undefined;
  const endCard =
    edit?.style.endCard && input.plan.title.trim()
      ? await layout.layoutText(input.plan.title.trim(), END_CARD_STYLE)
      : undefined;
  const gfx = edit?.style.graphics;
  const fps = input.source.fps.num / input.source.fps.den;
  const prices = gfx?.priceTag
    ? await Promise.all(
        priceMentions(pages, { minGapFrames: Math.round(3 * fps), maxPerClip: gfx.priceTag.maxPerClip }).map(
          async (m) => ({ frame: m.frame, text: await layout.layoutText(m.text, PRICE_TAG_STYLE) }),
        ),
      )
    : [];
  const name =
    gfx?.productName && productName?.trim()
      ? await layout.layoutText(productName.trim(), PRODUCT_NAME_STYLE)
      : undefined;
  const cta = gfx?.cta ? await layout.layoutText(gfx.cta.label, CTA_STYLE) : undefined;
  const graphics = gfx
    ? { prices, ...(name ? { productName: name } : {}), ...(cta ? { cta } : {}) }
    : undefined;
  const project = buildClipProject({
    ...rest,
    pages,
    hook,
    endCard,
    edit,
    ...(graphics ? { graphics } : {}),
  });
  const v = validateProject(project);
  if (!v.ok) throw new InvalidClipProjectError(v.errors);
  return project;
}
