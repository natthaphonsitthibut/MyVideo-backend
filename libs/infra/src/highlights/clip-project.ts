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
import { planTransitions } from './transitions.js';

/**
 * Clip plan → Project JSON (E07-F07): deterministic. One 9:16 `cover` video element (centre crop; the reframe
 * offset is the element's `transform.x`, 0 = centre, adjustable by the user), caption pages from the transcript
 * words (laid out by the stage's own builder + font), and the hook as a text element on an overlay track for the
 * first seconds. Every element is `origin: 'ai'` and `meta.createdBy = 'ai'`: the workflow made it, the user
 * did not; the user's later edits create new versions (ARCHITECTURE §6).
 */
export const CLIP_WIDTH = 1080;
export const CLIP_HEIGHT = 1920;

/**
 * Output frames (E12-F09). Positions in the style packs are designed on the 1080×1920 frame: on another frame a
 * vertical position keeps its share of the frame height (`y · height / 1920`) and text is drawn at `textScale`
 * (laid out on a design column `width / textScale` wide, so wide frames get longer lines, not bigger letters).
 * **Assumption** (no platform measurement yet): text scales chosen so the largest caption line stays ≤ 7 % of the
 * frame height on 16:9 and the safe-zone lint below passes for every style.
 */
export const OUTPUT_FRAMES = {
  '9:16': { width: 1080, height: 1920, textScale: 1 },
  '4:5': { width: 1080, height: 1350, textScale: 0.85 },
  '1:1': { width: 1080, height: 1080, textScale: 0.75 },
  '16:9': { width: 1920, height: 1080, textScale: 0.7 },
} as const;
export type OutputRatio = keyof typeof OUTPUT_FRAMES;
/** Design column for laying out text on a frame (≤ 1600 so a 16:9 caption line stays readable at a glance). */
export const layoutWidth = (ratio: OutputRatio) =>
  Math.min(1600, Math.round(OUTPUT_FRAMES[ratio].width / OUTPUT_FRAMES[ratio].textScale));
/** Behind a picture that does not fill the frame (never stretched): a plain dark backdrop. */
const BACKDROP = '#111111';
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
  /** Display size of the source (after rotation); unknown = treated as filling the frame. */
  width?: number;
  height?: number;
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
 * Camera rules (D-037, after the user's "the picture bounces" report; measured on an AI clip: framing changed
 * every 1–3 s between 1.0 / 1.08 / 1.2 and was zoomed 63 % of the time). Sources: research/notes/kitti-study.md
 * §3.1 and critic item 19, skill `short-form-editing` §2.4.
 */
export const CAMERA_RULES = {
  /**
   * Minimum time between two framing changes (skill `short-form-editing` §2.4: never two zoom changes within ~2 s;
   * 2.5 s left almost no spoken price long enough for a punch-in).
   */
  holdSeconds: 2,
  /** Share of the clip that may be zoomed in. */
  maxZoomShare: 0.2,
} as const;

/** Scale per shot (see `segmentShots`). */
export function segmentScales(
  style: StylePack,
  segments: readonly EditSegmentFrames[],
  minFrames = 30,
): number[] {
  return segmentShots(style, segments, minFrames).map((s) => s.scale);
}

export type Shot = {
  scale: number;
  /** The key moment a punch-in marks (the camera moved for it). */
  punch: 'price' | 'cta' | null;
  /** The key moment spoken in this shot, whether or not the camera moved (sound effects follow the words). */
  moment: 'price' | 'cta' | null;
};

/**
 * Framing per shot. The base framing (1.0) most of the time; the style's punch-in only where a price / call to
 * action is spoken, and only when ALL hold:
 *  - the shot starts at a jump cut (the source jumps) — a continuous take never re-frames mid-sentence;
 *  - ≥ `holdSeconds` since the last framing change, and the punch can be released at a later jump cut that is
 *    again ≥ `holdSeconds` away (or the clip ends);
 *  - the zoomed stretch keeps the clip within `maxZoomShare`;
 *  - not within `punchGap` shots of the previous punch, and the shot is at least `minFrames` long.
 * From a zoom the only change is back to 1.0 (never zoom → other zoom).
 */
export function segmentShots(
  style: StylePack,
  segments: readonly EditSegmentFrames[],
  /** Pieces shorter than this never change framing (≈ 1 s at the clip fps). */
  minFrames = 30,
): Shot[] {
  const fpsFrames = minFrames; // callers pass one second of frames
  const hold = Math.round(CAMERA_RULES.holdSeconds * fpsFrames);
  const total = segments.reduce((n, s) => n + s.durationFrames, 0);
  const budget = Math.floor(total * CAMERA_RULES.maxZoomShare);
  const isJump = (i: number) => {
    const prev = segments[i - 1];
    const cur = segments[i];
    return !!prev && !!cur && prev.sourceInFrame + prev.durationFrames !== cur.sourceInFrame;
  };
  /** Frames from shot `i` until the first later jump cut at least `hold` after it (or the clip end). */
  const stretchFrom = (i: number) => {
    const start = segments[i]?.startFrame ?? 0;
    for (let j = i + 1; j < segments.length; j++) {
      const at = segments[j]?.startFrame ?? 0;
      if (isJump(j) && at - start >= hold && (segments[j]?.durationFrames ?? 0) >= minFrames)
        return at - start;
    }
    return total - start;
  };
  let scale = 1;
  let lastChange = 0;
  let zoomed = 0;
  let sincePunch = Number.POSITIVE_INFINITY;
  return segments.map((s, i) => {
    const moment = keyMomentKind(s.words);
    const canChange =
      i > 0 && isJump(i) && s.durationFrames >= minFrames && s.startFrame - lastChange >= hold;
    let punch: Shot['punch'] = null;
    if (canChange && scale !== 1) {
      scale = 1;
      lastChange = s.startFrame;
    } else if (
      canChange &&
      moment !== null &&
      style.zoom.punchIn !== null &&
      sincePunch >= Math.max(1, style.zoom.punchGap) &&
      zoomed + stretchFrom(i) <= budget
    ) {
      scale = style.zoom.punchIn;
      punch = moment;
      lastChange = s.startFrame;
      sincePunch = 0;
    }
    sincePunch++;
    if (scale > 1) zoomed += s.durationFrames;
    return { scale, punch, moment };
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
  /** Output frame; default 9:16. */
  ratio?: OutputRatio;
  /** Where the face is across the clip (0..1 of the source width); keeps it in view when the frame crops the sides. */
  faceX?: number;
}): Project {
  const { source, plan, pages, hook, edit } = input;
  const newId = seededIds(input.seed);
  const out = OUTPUT_FRAMES[input.ratio ?? '9:16'];
  const W = out.width;
  const H = out.height;
  /** A text/graphic position designed on 1080×1920 → this frame (same share of the height, scaled text). */
  const place = (y: number) => ({
    x: 0,
    y: Math.round((y * H) / CLIP_HEIGHT),
    scale: out.textScale,
    rotation: 0,
  });
  // how the picture sits in the frame: a source much narrower than the frame is shown whole over a backdrop
  const srcAspect = source.width && source.height ? source.width / source.height : W / H;
  const inside = srcAspect < (W / H) * 0.85;
  /** Displayed width of a `cover` picture at scale 1 and the shift that centres the face, clamped to the picture. */
  const coverWidth = srcAspect > W / H ? H * srcAspect : W;
  const faceShift = (scale: number) => {
    if (inside || input.faceX === undefined || coverWidth <= W) return 0;
    const wanted = (0.5 - input.faceX) * coverWidth * scale;
    const limit = (coverWidth * scale - W) / 2;
    return Math.round(Math.max(-limit, Math.min(limit, wanted)));
  };
  const frames = edit ? editFrames(source, plan, edit.cut) : undefined;
  const plain = clipFrames(source, plan);
  const durationFrames = frames?.durationFrames ?? plain.durationFrames;
  const segments = frames?.segments ?? [
    { sourceInFrame: plain.sourceInFrame, startFrame: 0, durationFrames, words: [] },
  ];
  const shots = edit
    ? segmentShots(edit.style, segments, Math.round(source.fps.num / source.fps.den))
    : segments.map((): Shot => ({ scale: 1, punch: null, moment: null }));
  const scales = shots.map((s) => s.scale);
  const assetId = newId();
  const videoTrack = newId();
  const captionTrack = newId();
  const overlayTrack = newId();
  // every text and graphic is placed on the output frame through `place` (E12-F09)
  const transform = place;
  const elements: Project['elements'] = {};
  const drift = edit?.style.zoom.drift ?? 0;
  // one slow push-in per RUN of shots with the same framing (not per shot: restarting the push at every cut made
  // the picture snap back at each cut); rounded to keep the JSON readable
  const runs: { from: number; frames: number }[] = [];
  segments.forEach((seg, i) => {
    const last = runs.at(-1);
    if (last && i > 0 && scales[i] === scales[i - 1]) last.frames += seg.durationFrames;
    else runs.push({ from: seg.startFrame, frames: seg.durationFrames });
  });
  const runOf = (frame: number) => runs.findLast((r) => r.from <= frame) ?? { from: 0, frames: 1 };
  const pushAt = (scale: number, frame: number) => {
    const r = runOf(frame);
    const t = r.frames > 1 ? (frame - r.from) / (r.frames - 1) : 0;
    return Math.round(scale * (1 + drift * t) * 10_000) / 10_000;
  };
  const videoIds = segments.map((seg, i) => {
    const id = newId();
    const scale = scales[i] ?? 1;
    const lastFrame = seg.startFrame + seg.durationFrames - 1;
    elements[id] = {
      ...(drift > 0 && seg.durationFrames > 1
        ? {
            keyframes: {
              'transform.scale': [
                { frame: 0, value: pushAt(scale, seg.startFrame), easing: 'linear' as const },
                { frame: seg.durationFrames - 1, value: pushAt(scale, lastFrame), easing: 'linear' as const },
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
      transform: {
        x: faceShift(scale),
        y: Math.round((scale - 1) * (H / 2) * ZOOM_KEEP_TOP),
        scale,
        rotation: 0,
      },
      fit: inside ? 'contain' : 'cover',
    };
    return id;
  });
  const backdropTrack = inside ? newId() : undefined;
  const backdropId = inside ? newId() : undefined;
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

  // transitions (E13-F05): created after everything above so ids of clips without transitions never change
  const transitionIds: string[] = [];
  const transitionTrack = edit?.style.transitions ? newId() : undefined;
  if (edit && transitionTrack) {
    const planned = planTransitions(
      edit.style.transitions,
      segments.map((s, i) => ({ startFrame: s.startFrame, moment: shots[i]?.moment ?? null })),
      fps,
    );
    let side = 1;
    for (const t of planned) {
      const seg = segments[t.index];
      const vid = videoIds[t.index];
      const v = vid ? elements[vid] : undefined;
      if (!seg || !v || v.type !== 'video') continue;
      if (t.kind === 'flash' || t.kind === 'dip') {
        // a white frame that fades out / a short dip to black across the cut: plain shapes, editable like any layer
        const id = newId();
        const dip = t.kind === 'dip';
        const startFrame = dip ? Math.max(0, seg.startFrame - 3) : seg.startFrame;
        const frames = Math.min(dip ? 6 : 5, durationFrames - startFrame);
        if (frames < 2) continue;
        elements[id] = {
          type: 'shape',
          id,
          trackId: transitionTrack,
          startFrame,
          durationFrames: frames,
          origin: 'ai',
          shape: 'rect',
          width: W,
          height: H,
          fill: dip ? '#000000' : '#ffffff',
          opacity: dip ? 1 : 0.85,
          transform: { x: 0, y: 0, scale: 1, rotation: 0 },
          ...(dip ? { animationIn: { presetId: 'fade', durationFrames: Math.floor(frames / 2) } } : {}),
          animationOut: { presetId: 'fade', durationFrames: dip ? Math.ceil(frames / 2) : frames },
        };
        transitionIds.push(id);
        continue;
      }
      // zoom punch / slide push: the next shot itself moves in and settles (ease-out), on top of its drift
      const settle = Math.min(t.kind === 'zoom-punch' ? 6 : 5, v.durationFrames - 1);
      if (settle < 2) continue;
      const kf = { ...(v.keyframes ?? {}) };
      const base = v.transform;
      if (t.kind === 'zoom-punch') {
        const drift = kf['transform.scale'];
        const end = drift?.at(-1) ?? {
          frame: v.durationFrames - 1,
          value: base.scale,
          easing: 'linear' as const,
        };
        const at = drift ? pushAt(base.scale, seg.startFrame + settle) : base.scale;
        kf['transform.scale'] = [
          { frame: 0, value: Math.round(base.scale * 1.18 * 10_000) / 10_000, easing: 'ease-out' },
          { frame: settle, value: at, easing: 'linear' },
          ...(end.frame > settle ? [end] : []),
        ];
      } else {
        kf['transform.x'] = [
          { frame: 0, value: base.x + side * Math.round(W * 0.18), easing: 'ease-out' },
          { frame: settle, value: base.x, easing: 'linear' },
        ];
        side = -side;
      }
      elements[vid as string] = { ...v, keyframes: kf };
    }
  }

  if (backdropTrack && backdropId)
    elements[backdropId] = {
      type: 'shape',
      id: backdropId,
      trackId: backdropTrack,
      startFrame: 0,
      durationFrames,
      origin: 'ai',
      shape: 'rect',
      width: W,
      height: H,
      fill: BACKDROP,
      transform: { x: 0, y: 0, scale: 1, rotation: 0 },
    };

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
      // the words decide the sound, not the camera (a price said too soon for a re-frame still gets its sound)
      const moment = shots[i]?.moment ?? null;
      if (moment === 'price') {
        // a price sound only means something the first time or two
        if (prices < (edit.style.sfx?.maxPrice ?? 0)) moments.push({ frame: seg.startFrame, kind: 'price' });
        prices++;
      } else if (moment) moments.push({ frame: seg.startFrame, kind: moment });
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
    width: W,
    height: H,
    durationFrames,
    assets,
    tracks: [
      ...(backdropTrack && backdropId
        ? [{ id: backdropTrack, kind: 'overlay' as const, elementIds: [backdropId] }]
        : []),
      { id: videoTrack, kind: 'video', elementIds: videoIds },
      ...(transitionTrack && transitionIds.length
        ? [{ id: transitionTrack, kind: 'overlay' as const, elementIds: transitionIds }]
        : []),
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

/** Caption line height used by the lint: the largest caption font (96 px) plus spacing — an upper bound. */
const LINT_CAPTION_LINE_PX = 110;

/**
 * Safe-zone lint (E12-F09): every text and caption box, as placed and scaled, must sit inside the frame with a
 * margin of 4 % of the height at the top and bottom. Horizontal fit is guaranteed by laying text out on the
 * frame's design column. Returns the problems (empty = OK).
 */
export function layoutLint(project: Project): string[] {
  const margin = project.height * 0.04;
  const out: string[] = [];
  for (const e of Object.values(project.elements)) {
    let lines = 0;
    let lineHeight = 0;
    if (e.type === 'text') {
      lines = Math.max(1, e.content.split('\n').length);
      lineHeight = e.style ? e.style.fontSize * 1.3 : LINT_CAPTION_LINE_PX;
    } else if (e.type === 'caption') {
      lines = Math.max(1, e.lines.length);
      lineHeight = LINT_CAPTION_LINE_PX;
    } else continue;
    const half = (lines * lineHeight * e.transform.scale) / 2;
    const top = e.transform.y - half;
    const bottom = e.transform.y + half;
    if (top < -project.height / 2 + margin || bottom > project.height / 2 - margin)
      out.push(`${e.type} ${e.id} at y=${e.transform.y} spans ${Math.round(top)}..${Math.round(bottom)}`);
  }
  return out;
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
    style?: { styleId?: string; speech: readonly SpanMs[]; resolved?: StylePack };
    /** The merchant's product name (lower-third, emphasis) — only what the merchant typed. */
    productName?: string;
  },
): Promise<Project> {
  const { style: styleInput, productName, ...rest } = input;
  let edit: { style: StylePack; cut: JumpCutPlan } | undefined;
  if (styleInput) {
    const style = styleInput.resolved ?? stylePack(styleInput.styleId);
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
            canvasWidth: layoutWidth(input.ratio ?? '9:16'),
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
