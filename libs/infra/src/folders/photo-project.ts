import { type Project, type ProjectElement, validateProject } from '@myvideo/contracts';
import { OUTPUT_FRAMES, type OutputRatio, seededIds } from '../highlights/clip-project.js';

export type VisualFootage = {
  sourceId: string;
  kind: 'image' | 'video';
  width: number;
  height: number;
  durationFrames: number;
};
const transform = { x: 0, y: 0, scale: 1, rotation: 0 };
function checked(project: Project): Project {
  const result = validateProject(project);
  if (!result.ok) throw new Error(`Invalid photo composition: ${JSON.stringify(result.errors)}`);
  return result.project;
}
function picture(
  id: string,
  trackId: string,
  assetId: string,
  startFrame: number,
  durationFrames: number,
): ProjectElement {
  return {
    type: 'image',
    id,
    trackId,
    assetId,
    startFrame,
    durationFrames,
    origin: 'ai',
    fit: 'contain',
    presentation: 'showcase',
    transform: { ...transform },
    keyframes: {
      'transform.scale': [
        { frame: 0, value: 1, easing: 'ease-in-out' },
        { frame: durationFrames - 1, value: 1.08, easing: 'ease-in-out' },
      ],
    },
  };
}
/** All timing is in project frames. Pictures are never stretched; video audio is untouched underneath cutaways. */
export function addPhotoCutaways(input: Project, photos: readonly VisualFootage[], seed: string): Project {
  const project = structuredClone(input);
  const ids = seededIds(`${seed}:photos`);
  const budget = Math.floor(project.durationFrames / 4);
  const count = Math.min(
    photos.length,
    Math.floor(budget / Math.max(1, Math.round(project.fps.num / project.fps.den))),
  );
  if (!count) return project;
  const trackId = ids();
  const elementIds: string[] = [];
  // Below text/captions, above picture: a cutaway never hides the spoken captions or hooks.
  const at = project.tracks.findIndex((t) => t.kind === 'caption' || t.kind === 'overlay');
  project.tracks.splice(at < 0 ? project.tracks.length : at, 0, { id: trackId, kind: 'overlay', elementIds });
  for (let i = 0; i < count; i++) {
    const photo = photos[i] as VisualFootage;
    const durationFrames = Math.min(
      Math.floor(budget / count),
      Math.round((2 * project.fps.num) / project.fps.den),
    );
    const startFrame = Math.min(
      project.durationFrames - durationFrames,
      Math.round(((i + 1) * project.durationFrames) / (count + 1)),
    );
    const assetId = ids();
    const id = ids();
    project.assets[assetId] = { ...photo, kind: 'image', hasAudio: false };
    project.elements[id] = picture(id, trackId, assetId, startFrame, durationFrames);
    elementIds.push(id);
  }
  return checked(project);
}

/** A plain editable visual sequence when there is no speech video to cut; selected source order is preserved. */
export function buildVisualMontage(input: {
  projectId: string;
  merchantId: string;
  seed: string;
  ratio: OutputRatio;
  sources: readonly VisualFootage[];
  seconds?: number;
  workflowRunId?: string;
}): Project {
  if (!input.sources.length) throw new Error('Select at least one picture or silent video');
  const ids = seededIds(input.seed);
  const trackId = ids();
  const frame = OUTPUT_FRAMES[input.ratio];
  const target = Math.round((input.seconds ?? input.sources.length * 5) * 30);
  const per = Math.max(1, Math.floor(target / input.sources.length));
  const project: Project = {
    schemaVersion: 1,
    id: input.projectId,
    merchantId: input.merchantId,
    fps: { num: 30, den: 1 },
    width: frame.width,
    height: frame.height,
    durationFrames: target,
    tracks: [{ id: trackId, kind: 'video', elementIds: [] }],
    assets: {},
    elements: {},
    meta: {
      createdBy: 'ai',
      title: 'ภาพสินค้า',
      ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
    },
  };
  let cursor = 0;
  for (const [i, source] of input.sources.entries()) {
    const assetId = ids();
    const id = ids();
    const durationFrames =
      source.kind === 'image'
        ? i === input.sources.length - 1
          ? target - cursor
          : per
        : Math.min(per, source.durationFrames);
    project.assets[assetId] = { ...source, hasAudio: false };
    project.elements[id] =
      source.kind === 'image'
        ? picture(id, trackId, assetId, cursor, durationFrames)
        : {
            type: 'video',
            id,
            trackId,
            assetId,
            startFrame: cursor,
            durationFrames,
            sourceInFrame: 0,
            playbackRate: 1,
            volume: 0,
            origin: 'ai',
            fit: 'contain',
            transform: { ...transform },
          };
    project.tracks[0]?.elementIds.push(id);
    cursor += durationFrames;
  }
  project.durationFrames = cursor;
  return checked(project);
}
