import {
  type AudioClip,
  audioFilterGraph,
  type Fps,
  type MediaCut,
  type RenderPreset,
} from '@myvideo/domain';

/** Encode settings per export preset (H.264 High + AAC, BT.709, faststart). */
export const PRESET_SETTINGS: Record<
  RenderPreset,
  { crf: number; x264Preset: string; audioBitrate: string }
> = {
  standard: { crf: 20, x264Preset: 'veryfast', audioBitrate: '160k' },
  high: { crf: 16, x264Preset: 'medium', audioBitrate: '256k' },
};

const rate = (fps: Fps) => `${fps.num}/${fps.den}`;
const num = (x: number) => String(Math.round(x * 1e6) / 1e6);

/**
 * A frame-accurate, all-intra copy of the range an element shows, at the project fps: the page can seek every
 * frame without decoding a GOP (originals often have 2–10 s GOPs). Two spare frames at the end.
 */
export function cutArgs(input: string, cut: MediaCut, fps: Fps, out: string): string[] {
  const frame = fps.den / fps.num;
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    num(cut.startSec),
    '-i',
    input,
    '-t',
    num(cut.durationSec + 2 * frame),
    '-an',
    '-vf',
    `fps=${rate(fps)},format=yuv420p`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '12',
    '-x264-params',
    'keyint=1',
    '-movflags',
    '+faststart',
    out,
  ];
}

/**
 * Encoder fed with JPEG frames on stdin (input 0) plus each audio clip cut from its original (inputs 1..n),
 * mixed by `audioFilterGraph`. Output frame count and length are fixed to the project's.
 */
export function encodeArgs(opts: {
  fps: Fps;
  frames: number;
  totalSec: number;
  audio: (AudioClip & { path: string })[];
  preset: RenderPreset;
  out: string;
}): string[] {
  const s = PRESET_SETTINGS[opts.preset];
  const inputs = opts.audio.flatMap((a) => ['-ss', num(a.startSec), '-t', num(a.durationSec), '-i', a.path]);
  const graph = audioFilterGraph(
    opts.audio.map((a, i) => ({ input: i + 1, rate: a.rate, volume: a.volume, delaySec: a.delaySec })),
    opts.totalSec,
  );
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'image2pipe',
    '-c:v',
    'mjpeg',
    '-framerate',
    rate(opts.fps),
    '-i',
    'pipe:0',
    ...inputs,
    '-filter_complex',
    `[0:v]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[vout];${graph}`,
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    '-c:v',
    'libx264',
    '-preset',
    s.x264Preset,
    '-crf',
    String(s.crf),
    '-profile:v',
    'high',
    '-r',
    rate(opts.fps),
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-color_range',
    'tv',
    '-frames:v',
    String(opts.frames),
    '-c:a',
    'aac',
    '-b:a',
    s.audioBitrate,
    '-ar',
    '48000',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    opts.out,
  ];
}
