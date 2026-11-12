import { createHash } from 'node:crypto';
import { type Project, validateProject } from '@myvideo/contracts';
import type { LaidOutCaptionPage, LaidOutText, LayoutWord, StageTextLayout } from '../render/text-layout.js';

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
const HOOK_STYLE = { fontWeight: 800, fontSizes: [88, 76, 64, 56], maxWidth: 880, maxLines: 3 };

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

/** Clip range in source frames and the words in clip-relative frames (what the caption builder takes). */
export function clipFrames(source: ClipSourceInfo, plan: ClipPlan) {
  const sourceInFrame = Math.max(0, Math.floor((plan.startMs * source.fps.num) / (1000 * source.fps.den)));
  const end = Math.min(
    source.durationFrames,
    Math.ceil((plan.endMs * source.fps.num) / (1000 * source.fps.den)),
  );
  const durationFrames = Math.max(1, end - sourceInFrame);
  const words: LayoutWord[] = plan.words
    .map((w) => ({
      text: w.text.trim(),
      startFrame: Math.max(0, toFrame(w.startMs, source.fps) - sourceInFrame),
      endFrame: Math.min(durationFrames, toFrame(w.endMs, source.fps) - sourceInFrame),
    }))
    .filter((w) => w.text.length > 0 && w.endFrame > w.startFrame);
  return { sourceInFrame, durationFrames, words };
}

/** Pure: plan + laid-out captions/hook → a Project (id/merchant set by the caller's insert). */
export function buildClipProject(input: {
  projectId: string;
  merchantId: string;
  workflowRunId?: string;
  source: ClipSourceInfo;
  plan: ClipPlan;
  pages: LaidOutCaptionPage[];
  hook?: LaidOutText;
  seed: string;
}): Project {
  const { source, plan, pages, hook } = input;
  const newId = seededIds(input.seed);
  const { sourceInFrame, durationFrames } = clipFrames(source, plan);
  const assetId = newId();
  const videoTrack = newId();
  const captionTrack = newId();
  const overlayTrack = newId();
  const transform = (y: number) => ({ x: 0, y, scale: 1, rotation: 0 });
  const elements: Project['elements'] = {};
  const videoId = newId();
  elements[videoId] = {
    type: 'video',
    id: videoId,
    trackId: videoTrack,
    startFrame: 0,
    durationFrames,
    origin: 'ai',
    assetId,
    sourceInFrame,
    playbackRate: 1,
    volume: 1,
    transform: transform(0),
    fit: 'cover',
  };
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
          const original = plan.words.find(
            (w) =>
              w.asrText !== undefined &&
              w.text.trim() === word.text &&
              Math.max(0, toFrame(w.startMs, source.fps) - sourceInFrame) ===
                p.startFrame + word.startFrame &&
              Math.min(durationFrames, toFrame(w.endMs, source.fps) - sourceInFrame) ===
                p.startFrame + word.endFrame,
          );
          return original ? { ...word, origin: 'ai' as const, asrText: original.asrText } : word;
        }),
        lines: p.lines,
        styleRef: CLIP_CAPTION_STYLE,
        transform: transform(CAPTION_Y),
      };
      return id;
    });
  const overlayIds: string[] = [];
  if (input.plan.hook && hook) {
    const id = newId();
    const fps = source.fps.num / source.fps.den;
    elements[id] = {
      type: 'text',
      id,
      trackId: overlayTrack,
      startFrame: 0,
      durationFrames: Math.min(durationFrames, Math.round(HOOK_SECONDS * fps)),
      origin: 'ai',
      content: hook.text,
      style: {
        fontFamily: 'Noto Sans Thai Variable',
        fontWeight: HOOK_STYLE.fontWeight,
        fontSize: hook.fontSize,
        color: '#ffffff',
        background: '#000000aa',
        align: 'center',
      },
      transform: transform(HOOK_Y),
      animationIn: { presetId: 'pop', durationFrames: Math.min(12, durationFrames) },
    };
    overlayIds.push(id);
  }
  return {
    schemaVersion: 1,
    id: input.projectId,
    merchantId: input.merchantId,
    fps: { num: source.fps.num, den: source.fps.den },
    width: CLIP_WIDTH,
    height: CLIP_HEIGHT,
    durationFrames,
    assets: {
      [assetId]: {
        sourceId: source.sourceId,
        kind: 'video',
        durationFrames: source.durationFrames,
        hasAudio: source.hasAudio,
      },
    },
    tracks: [
      { id: videoTrack, kind: 'video', elementIds: [videoId] },
      { id: captionTrack, kind: 'caption', elementIds: captionIds },
      ...(overlayIds.length > 0
        ? [{ id: overlayTrack, kind: 'overlay' as const, elementIds: overlayIds }]
        : []),
    ],
    elements,
    meta: {
      createdBy: 'ai',
      ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
      title: plan.title.slice(0, 200),
    },
  } as Project;
}

export class InvalidClipProjectError extends Error {
  constructor(readonly issues: { path: string; message: string }[]) {
    super(`built clip project is invalid: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
    this.name = 'InvalidClipProjectError';
  }
}

/** Lays out captions + hook with the stage, builds and validates the project. */
export async function layoutClipProject(
  layout: StageTextLayout,
  input: Omit<Parameters<typeof buildClipProject>[0], 'pages' | 'hook'>,
): Promise<Project> {
  const { words } = clipFrames(input.source, input.plan);
  const pages =
    words.length > 0
      ? await layout.layoutCaptions(words, { styleRef: CLIP_CAPTION_STYLE, canvasWidth: CLIP_WIDTH })
      : [];
  const hook = input.plan.hook ? await layout.layoutText(input.plan.hook.text, HOOK_STYLE) : undefined;
  const project = buildClipProject({ ...input, pages, hook });
  const v = validateProject(project);
  if (!v.ok) throw new InvalidClipProjectError(v.errors);
  return project;
}
