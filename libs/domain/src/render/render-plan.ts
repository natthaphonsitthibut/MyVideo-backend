/**
 * Pure planning for a render (ARCHITECTURE §7): which source ranges to cut, the project the render page draws,
 * and the audio mix. No I/O — the adapter runs ffmpeg/Chromium from this plan.
 */

export type Fps = { num: number; den: number };

import { type SpeechDuck } from './audio-envelope.js';

/** The parts of Project JSON v1 the render plan reads (structural; the contracts validator runs first). */
export type RenderProject = {
  fps: Fps;
  width: number;
  height: number;
  durationFrames: number;
  assets: Record<
    string,
    {
      sourceId?: string;
      libraryId?: string;
      musicId?: string;
      kind: 'video' | 'audio' | 'image';
      durationFrames: number;
      hasAudio: boolean;
    }
  >;
  elements: Record<string, RenderElement>;
  [k: string]: unknown;
};
export type RenderElement = {
  id: string;
  type: string;
  startFrame: number;
  durationFrames: number;
  assetId?: string;
  sourceInFrame?: number;
  playbackRate?: number;
  volume?: number;
  [k: string]: unknown;
};

/** A source range the adapter turns into a frame-accurate, all-intra clip at the project fps. */
export type MediaCut = {
  /** Asset id the render page uses (= the element id: one cut per element). */
  assetId: string;
  /** Asset id in the original project (→ the source's original file). */
  sourceAssetId: string;
  startSec: number;
  durationSec: number;
};

/** One sound in the mix; times in seconds, read straight from the original file. */
export type AudioClip = {
  ducking?: SpeechDuck;
  fadeInSec?: number;
  fadeOutSec?: number;
  sourceAssetId: string;
  startSec: number;
  durationSec: number;
  /** Where the clip starts on the output timeline. */
  delaySec: number;
  rate: number;
  volume: number;
};

export type RenderPlan = {
  project: RenderProject;
  cuts: MediaCut[];
  /** Image assets the page loads as they are (original files). */
  images: string[];
  audio: AudioClip[];
  totalSec: number;
};

const sec = (frames: number, fps: Fps) => (frames * fps.den) / fps.num;

export function planRender(input: RenderProject): RenderPlan {
  const p = structuredClone(input);
  const cuts: MediaCut[] = [];
  const audio: AudioClip[] = [];
  const images = new Set<string>();
  const assets: RenderProject['assets'] = {};
  const mutedTracks = new Set(
    ((p.tracks as { id: string; muted?: boolean }[] | undefined) ?? [])
      .filter((t) => t.muted)
      .map((t) => t.id),
  );
  for (const e of Object.values(p.elements)) {
    if (e.type !== 'video' && e.type !== 'audio' && e.type !== 'image') continue;
    const sourceAssetId = e.assetId as string;
    const asset = input.assets[sourceAssetId];
    if (!asset) throw new Error(`element ${e.id} uses unknown asset ${sourceAssetId}`);
    if (e.type === 'image') {
      images.add(sourceAssetId);
      assets[sourceAssetId] = asset;
      continue;
    }
    const rate = e.playbackRate ?? 1;
    const startSec = sec(e.sourceInFrame ?? 0, p.fps);
    const durationSec = (sec(e.durationFrames, p.fps) * rate) as number;
    // a muted track (advanced timeline) is silent in the render exactly as in the preview
    const volume = mutedTracks.has(e.trackId as string) ? 0 : (e.volume ?? 1);
    if (asset.hasAudio && volume > 0) {
      const track = ((p.tracks ?? []) as { id: string; ducking?: SpeechDuck }[]).find(
        (t) => t.id === e.trackId,
      );
      audio.push({
        sourceAssetId,
        startSec,
        durationSec,
        delaySec: sec(e.startFrame, p.fps),
        rate,
        volume,
        ...(track?.ducking ? { ducking: track.ducking } : {}),
        ...(typeof e.fadeInFrames === 'number' ? { fadeInSec: sec(e.fadeInFrames, p.fps) } : {}),
        ...(typeof e.fadeOutFrames === 'number' ? { fadeOutSec: sec(e.fadeOutFrames, p.fps) } : {}),
      });
    }
    if (e.type === 'video') {
      cuts.push({ assetId: e.id, sourceAssetId, startSec, durationSec });
      assets[e.id] = {
        sourceId: asset.sourceId,
        kind: 'video',
        durationFrames: Math.ceil(e.durationFrames * rate),
        hasAudio: false,
      };
      e.assetId = e.id;
      e.sourceInFrame = 0;
    } else {
      // audio plays from the mix; the page keeps a (muted) element only for timing parity
      assets[sourceAssetId] = asset;
    }
  }
  p.assets = assets;
  return { project: p, cuts, images: [...images], audio, totalSec: sec(p.durationFrames, p.fps) };
}

/** atempo accepts 0.5–2 per instance; other rates are a chain. */
function atempo(rate: number): string {
  if (rate === 1) return '';
  const parts: number[] = [];
  let r = rate;
  while (r > 2) {
    parts.push(2);
    r /= 2;
  }
  while (r < 0.5) {
    parts.push(0.5);
    r /= 0.5;
  }
  if (Math.abs(r - 1) > 1e-9) parts.push(r);
  return parts.map((x) => `atempo=${x},`).join('');
}

/**
 * ffmpeg filter graph for the mix: each input `i` is already cut to its range (`-ss/-t` on the input), then
 * resampled, retimed, scaled and delayed; `amix` sums without normalising (volumes are the user's), and the
 * result is padded/trimmed to exactly `totalSec`. Output label `[aout]`.
 * The mix is re-timed from its sample count (`asetpts=N/SR/TB`) before the trim: with many delayed inputs (jump
 * cuts) amix's output timestamps were seen to start late (S01a: +1.867 s), so a timestamp trim cut off the tail.
 */
export function audioFilterGraph(
  clips: {
    input: number;
    rate: number;
    volume: number;
    delaySec: number;
    duck?: string;
    fadeInSec?: number;
    fadeOutSec?: number;
    durationSec?: number;
  }[],
  totalSec: number,
): string {
  const total = Math.round(totalSec * 1e6) / 1e6; // 29.97 fps lengths are long floats
  if (clips.length === 0) return `anullsrc=r=48000:cl=stereo,atrim=0:${total}[aout]`;
  const chains = clips.map(
    (c, i) =>
      `[${c.input}:a]aresample=48000,asetpts=PTS-STARTPTS,${atempo(c.rate)}volume=${c.volume},adelay=${Math.round(c.delaySec * 1000)}:all=1${c.duck ? `,volume='${c.duck}':eval=frame` : ''}${c.fadeInSec ? `,afade=t=in:st=${c.delaySec}:d=${c.fadeInSec}` : ''}${c.fadeOutSec ? `,afade=t=out:st=${c.delaySec + Math.max(0, (c.durationSec ?? 0) / c.rate - c.fadeOutSec)}:d=${c.fadeOutSec}` : ''}[a${i}]`,
  );
  const labels = clips.map((_, i) => `[a${i}]`).join('');
  return `${chains.join(';')};${labels}amix=inputs=${clips.length}:normalize=0:duration=longest,asetpts=N/SR/TB,apad,atrim=0:${total},asetpts=PTS-STARTPTS[aout]`;
}

/** Renders are cached per (project version, preset, stage version) — not by file hash (D-003). */
export const renderCacheKey = (projectVersionId: string, preset: string, stageVersion: string): string =>
  `${projectVersionId}:${preset}:${stageVersion}`;
