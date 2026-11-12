import { type ElementType, Project, type ProjectElement, type Track } from './schema.js';
import { librarySound } from './sound-library.js';

export type ProjectIssue = {
  /** Machine-readable rule id, e.g. `overlap`, `missing_asset`. */
  code: string;
  /** Dotted path into the project JSON. */
  path: string;
  message: string;
};

export type ProjectValidation = { ok: true; project: Project } | { ok: false; errors: ProjectIssue[] };

/** Which element types may sit on which track kind. */
const TRACK_ALLOWS: Record<Track['kind'], readonly ElementType[]> = {
  video: ['video', 'image'],
  audio: ['audio'],
  caption: ['caption'],
  overlay: ['text', 'image', 'shape', 'cta', 'video'],
};

/** Last frame (inclusive) an element covers. */
const lastFrame = (e: { startFrame: number; durationFrames: number }) => e.startFrame + e.durationFrames - 1;

/**
 * Pure validator for Project JSON (ARCHITECTURE §6), shared by the API (every save) and the worker (before every
 * render). Schema first; then cross-field rules with precise, path-addressed messages. Asset ownership by the
 * merchant is checked by the caller (needs the database).
 */
export function validateProject(input: unknown): ProjectValidation {
  const parsed = Project.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({
        code: 'schema',
        path: i.path.map(String).join('.'),
        message: i.message,
      })),
    };
  }
  const p = parsed.data;
  const errors: ProjectIssue[] = [];
  const add = (code: string, path: string, message: string) => errors.push({ code, path, message });

  // tracks: unique ids, members exist, each element listed once
  const trackById = new Map<string, Track>();
  const listedIn = new Map<string, string>();
  p.tracks.forEach((t, ti) => {
    if (trackById.has(t.id)) add('duplicate_track', `tracks.${ti}.id`, `track id ${t.id} is used twice`);
    trackById.set(t.id, t);
    t.elementIds.forEach((eid, ei) => {
      const path = `tracks.${ti}.elementIds.${ei}`;
      if (!p.elements[eid]) add('unknown_element', path, `element ${eid} does not exist`);
      else if (listedIn.has(eid)) add('track_membership', path, `element ${eid} is listed more than once`);
      else listedIn.set(eid, t.id);
    });
  });

  for (const [key, a] of Object.entries(p.assets)) {
    const at = `assets.${key}`;
    if ((a.sourceId === undefined) === (a.libraryId === undefined))
      add('asset_ref', at, `asset ${key} needs exactly one of sourceId or libraryId`);
    if (a.libraryId !== undefined) {
      const sound = librarySound(a.libraryId);
      if (!sound) add('library_asset', `${at}.libraryId`, `library sound ${a.libraryId} does not exist`);
      if (a.kind !== 'audio') add('library_asset', `${at}.kind`, `library asset ${key} must be audio`);
    }
  }

  const byTrack = new Map<string, ProjectElement[]>();
  for (const [key, e] of Object.entries(p.elements)) {
    const at = `elements.${key}`;
    if (e.id !== key) add('id_mismatch', `${at}.id`, `element ${e.id} is stored under key ${key}`);
    const track = trackById.get(e.trackId);
    if (!track) {
      add(
        'unknown_track',
        `${at}.trackId`,
        `element ${key} refers to track ${e.trackId}, which does not exist`,
      );
    } else {
      if (listedIn.get(key) !== e.trackId)
        add('track_membership', at, `element ${key} is not listed in its track ${e.trackId}`);
      if (!TRACK_ALLOWS[track.kind].includes(e.type))
        add('track_kind', at, `${e.type} element ${key} cannot sit on a ${track.kind} track`);
      byTrack.set(e.trackId, [...(byTrack.get(e.trackId) ?? []), e]);
    }
    const end = e.startFrame + e.durationFrames;
    if (end > p.durationFrames)
      add(
        'out_of_bounds',
        at,
        `element ${key} ends at frame ${end} but the project has ${p.durationFrames} frames`,
      );

    if ('assetId' in e) checkAsset(p, e, at, add);
    if (e.type === 'caption') checkCaption(e, at, add);
    if (e.type === 'text' && !e.style && !e.styleRef)
      add('text_style', at, `text element ${key} needs a style or styleRef`);
    for (const [prop, kfs] of Object.entries(e.keyframes ?? {})) {
      kfs.forEach((k, i) => {
        if (k.frame > e.durationFrames)
          add(
            'keyframe_bounds',
            `${at}.keyframes.${prop}.${i}`,
            `keyframe at frame ${k.frame} is outside the element (${e.durationFrames} frames)`,
          );
      });
    }
  }

  // no overlaps on one track (sorted sweep)
  for (const els of byTrack.values()) {
    const sorted = [...els].sort((a, b) => a.startFrame - b.startFrame);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (!prev || !cur) continue;
      if (cur.startFrame <= lastFrame(prev)) {
        add(
          'overlap',
          `elements.${cur.id}`,
          `element ${cur.id} overlaps ${prev.id} on track ${cur.trackId} at frames ${cur.startFrame}–${Math.min(lastFrame(prev), lastFrame(cur))}`,
        );
      }
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, project: p };
}

type Add = (code: string, path: string, message: string) => void;

function checkAsset(p: Project, e: ProjectElement & { assetId: string }, at: string, add: Add) {
  const asset = p.assets[e.assetId];
  if (!asset) {
    add('missing_asset', `${at}.assetId`, `asset ${e.assetId} is not in project assets`);
    return;
  }
  if (e.type === 'image' && asset.kind !== 'image')
    add('asset_kind', `${at}.assetId`, `image element uses ${asset.kind} asset ${e.assetId}`);
  if (e.type === 'video' && asset.kind !== 'video')
    add('asset_kind', `${at}.assetId`, `video element uses ${asset.kind} asset ${e.assetId}`);
  if (e.type === 'audio' && !(asset.kind === 'audio' || (asset.kind === 'video' && asset.hasAudio)))
    add('asset_kind', `${at}.assetId`, `audio element uses asset ${e.assetId}, which has no audio`);
  if (e.type === 'video' || e.type === 'audio') {
    // frames read from the asset; playbackRate scales them (rounded up: a partial frame is still read)
    const need = Math.ceil(e.durationFrames * e.playbackRate);
    const last = e.sourceInFrame + need - 1;
    if (last >= asset.durationFrames)
      add(
        'source_range',
        `${at}.sourceInFrame`,
        `element ${e.id} needs asset frames ${e.sourceInFrame}–${last} but the asset has ${asset.durationFrames} frames`,
      );
  }
}

function checkCaption(e: Extract<ProjectElement, { type: 'caption' }>, at: string, add: Add) {
  e.words.forEach((w, i) => {
    const path = `${at}.words.${i}`;
    if (w.endFrame <= w.startFrame)
      add('caption_word', path, `word ${i} "${w.text}" ends at or before it starts`);
    const prev = e.words[i - 1];
    if (prev && w.startFrame < prev.endFrame)
      add('caption_order', path, `word ${i} starts before word ${i - 1} ends (frame ${prev.endFrame})`);
    if (w.endFrame > e.durationFrames)
      add(
        'caption_bounds',
        path,
        `word ${i} ends at frame ${w.endFrame}, after the caption ends (${e.durationFrames})`,
      );
  });
  const flat = e.lines.flat();
  if (flat.length !== e.words.length || flat.some((wi, i) => wi !== i))
    add(
      'caption_lines',
      `${at}.lines`,
      `lines must list every word once, in order (0…${e.words.length - 1})`,
    );
}
