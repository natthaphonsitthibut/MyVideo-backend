import {
  PROJECT_SCHEMA_VERSION,
  type Project,
  type TemplateVersion,
  validateProject,
} from '@myvideo/contracts';
import { seededIds } from '../highlights/clip-project.js';
import type { LaidOutCaptionPage, LaidOutText, LayoutWord } from '../render/text-layout.js';
import type { TemplatePiece } from './template-engine.js';

export const TEMPLATE_FPS = { num: 30, den: 1 } as const;
const W = 1080;
const H = 1920;
const FONT = 'brand';

export type TemplateSource = { sourceId: string; durationMs: number; hasAudio: boolean };
type SpokenWord = { text: string; startMs: number; endMs: number };

const toFrames = (ms: number) => Math.round((ms * TEMPLATE_FPS.num) / (TEMPLATE_FPS.den * 1000));

/** Where each piece starts on the project timeline (frames), in order. */
export function pieceStarts(pieces: readonly TemplatePiece[]): number[] {
  const out: number[] = [];
  let at = 0;
  for (const p of pieces) {
    out.push(at);
    at += toFrames(p.outMs - p.inMs);
  }
  return out;
}

/** The words said inside the pieces, moved onto the project timeline (for the caption layout). */
export function templateCaptionWords(
  pieces: readonly TemplatePiece[],
  wordsBySource: ReadonlyMap<string, readonly SpokenWord[]>,
): LayoutWord[] {
  const starts = pieceStarts(pieces);
  const out: LayoutWord[] = [];
  pieces.forEach((p, i) => {
    const at = starts[i] ?? 0;
    const end = at + toFrames(p.outMs - p.inMs);
    for (const w of wordsBySource.get(p.sourceId) ?? []) {
      if (w.startMs < p.inMs || w.endMs > p.outMs) continue;
      const startFrame = at + toFrames(w.startMs - p.inMs);
      const endFrame = Math.min(end, at + toFrames(w.endMs - p.inMs));
      if (endFrame > startFrame && w.text.trim()) out.push({ text: w.text.trim(), startFrame, endFrame });
    }
  });
  return out;
}

/**
 * Template plan + laid-out texts → an editable Project (E10-F05), pure. Texts use brand kit tokens, so the merchant's
 * kit colours them at preview/render time. Only the merchant's words appear: product name, their points, their CTA,
 * and what they said on camera (captions).
 */
export function buildTemplateProject(input: {
  projectId: string;
  merchantId: string;
  workflowRunId: string;
  seed: string;
  title: string;
  template: TemplateVersion;
  pieces: readonly TemplatePiece[];
  sources: readonly TemplateSource[];
  captionPages: readonly LaidOutCaptionPage[];
  /** Laid-out text per piece index (title / point), same order as `pieces`. */
  pieceTexts: readonly (LaidOutText | null)[];
  cta: LaidOutText | null;
}): Project {
  const { template: t, pieces } = input;
  const newId = seededIds(input.seed);
  const starts = pieceStarts(pieces);
  const durationFrames =
    (starts.at(-1) ?? 0) + toFrames((pieces.at(-1)?.outMs ?? 0) - (pieces.at(-1)?.inMs ?? 0));
  const assets: Project['assets'] = {};
  const assetOf = new Map<string, string>();
  for (const s of input.sources) {
    if (!pieces.some((p) => p.sourceId === s.sourceId)) continue;
    const id = newId();
    assetOf.set(s.sourceId, id);
    assets[id] = {
      sourceId: s.sourceId,
      kind: 'video',
      durationFrames: toFrames(s.durationMs),
      hasAudio: s.hasAudio,
    };
  }
  const videoTrack = newId();
  const captionTrack = newId();
  const overlayTrack = newId();
  const elements: Project['elements'] = {};
  const videoIds = pieces.map((p, i) => {
    const id = newId();
    elements[id] = {
      type: 'video',
      id,
      trackId: videoTrack,
      startFrame: starts[i] ?? 0,
      durationFrames: toFrames(p.outMs - p.inMs),
      origin: 'ai',
      assetId: assetOf.get(p.sourceId) as string,
      sourceInFrame: toFrames(p.inMs),
      playbackRate: 1,
      volume: 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0 },
      fit: 'cover',
    };
    return id;
  });
  const captionIds = input.captionPages
    .filter((pg) => pg.startFrame < durationFrames)
    .map((pg) => {
      const id = newId();
      elements[id] = {
        type: 'caption',
        id,
        trackId: captionTrack,
        startFrame: pg.startFrame,
        durationFrames: Math.max(1, Math.min(pg.durationFrames, durationFrames - pg.startFrame)),
        origin: 'ai',
        words: pg.words.map((w) => ({ text: w.text, startFrame: w.startFrame, endFrame: w.endFrame })),
        lines: pg.lines,
        styleRef: t.captions.styleRef,
        transform: { x: 0, y: t.captions.y, scale: 1, rotation: 0 },
      };
      return id;
    });
  const overlayIds: string[] = [];
  const fps = TEMPLATE_FPS.num / TEMPLATE_FPS.den;
  pieces.forEach((p, i) => {
    const laid = input.pieceTexts[i];
    if (!p.text || !laid) return;
    const start = starts[i] ?? 0;
    const len = toFrames(p.outMs - p.inMs);
    const title = p.text.kind === 'title';
    const frames = title ? Math.min(len, Math.round(t.title.seconds * fps)) : len;
    const id = newId();
    elements[id] = {
      type: 'text',
      id,
      trackId: overlayTrack,
      startFrame: start,
      durationFrames: Math.max(1, frames),
      origin: 'ai',
      content: laid.text,
      style: {
        fontFamily: FONT,
        fontWeight: title ? 800 : 700,
        fontSize: laid.fontSize,
        color: title ? 'brand:text' : 'brand:primary',
        background: title ? 'brand:primary' : 'brand:accent',
        align: 'center',
      },
      transform: { x: 0, y: title ? t.title.y : -300, scale: 1, rotation: 0 },
      animationIn: {
        presetId: title ? t.title.animationIn : t.pointAnimationIn,
        durationFrames: Math.min(9, frames),
      },
    };
    overlayIds.push(id);
  });
  if (input.cta) {
    const frames = Math.min(durationFrames, Math.round(t.cta.seconds * fps));
    const id = newId();
    elements[id] = {
      type: 'text',
      id,
      trackId: overlayTrack,
      startFrame: durationFrames - frames,
      durationFrames: frames,
      origin: 'ai',
      content: input.cta.text,
      style: {
        fontFamily: FONT,
        fontWeight: 800,
        fontSize: input.cta.fontSize,
        color: 'brand:primary',
        background: 'brand:accent',
        align: 'center',
      },
      transform: { x: 0, y: t.cta.y, scale: 1, rotation: 0 },
      animationIn: { presetId: t.cta.animationIn, durationFrames: Math.min(12, frames) },
    };
    overlayIds.push(id);
  }
  const tracks: Project['tracks'] = [
    { id: videoTrack, kind: 'video', elementIds: videoIds },
    ...(captionIds.length ? [{ id: captionTrack, kind: 'caption' as const, elementIds: captionIds }] : []),
    ...(overlayIds.length ? [{ id: overlayTrack, kind: 'overlay' as const, elementIds: overlayIds }] : []),
  ];
  const project: Project = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: input.projectId,
    merchantId: input.merchantId,
    fps: { ...TEMPLATE_FPS },
    width: W,
    height: H,
    durationFrames,
    templateRef: { templateId: t.id, templateVersion: t.version },
    assets,
    tracks,
    elements,
    meta: { createdBy: 'ai', workflowRunId: input.workflowRunId, title: input.title.slice(0, 200) },
  };
  const v = validateProject(project);
  if (!v.ok) throw new Error(`template project invalid: ${JSON.stringify(v.errors).slice(0, 500)}`);
  return project;
}
