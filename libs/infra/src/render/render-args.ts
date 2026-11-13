import {
  type AudioClip,
  audioFilterGraph,
  duckingExpression,
  type Fps,
  LOUDNESS_TARGET,
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

/**
 * Sample-peak limiter at −2 dBFS after loudness normalisation: when the gain loudnorm needs pushes peaks over
 * the target (measured on C03: +0.15 dBTP without it), this keeps the AAC output under the true-peak target.
 */
export const PEAK_LIMITER = 'alimiter=limit=0.7943:attack=5:release=50:level=false:latency=true';

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
    '4',
    '-x264-params',
    'keyint=1',
    '-movflags',
    '+faststart',
    out,
  ];
}

/**
 * Audio pass 1: every clip cut from its original (inputs 0..n-1), mixed by `audioFilterGraph` to exactly the
 * project length, written as 48 kHz stereo PCM (the loudness measurement and the encoder read this file).
 */
export function mixArgs(
  audio: (AudioClip & { path: string })[],
  totalSec: number,
  out: string,
  fps = { num: 30, den: 1 },
): string[] {
  const inputs = audio.flatMap((a) => ['-ss', num(a.startSec), '-t', num(a.durationSec), '-i', a.path]);
  const graph = audioFilterGraph(
    audio.map((a, i) => ({
      input: i,
      rate: a.rate,
      volume: a.volume,
      delaySec: a.delaySec,
      ...(a.ducking ? { duck: duckingExpression(a.ducking, fps) } : {}),
      fadeInSec: a.fadeInSec,
      fadeOutSec: a.fadeOutSec,
      durationSec: a.durationSec,
    })),
    totalSec,
  );
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    ...inputs,
    '-filter_complex',
    graph,
    '-map',
    '[aout]',
    '-c:a',
    'pcm_s16le',
    '-ar',
    '48000',
    '-ac',
    '2',
    out,
  ];
}

/** Audio pass 2: EBU R128 measurement (`loudnorm … print_format=json` on stderr). */
export function measureArgs(wav: string): string[] {
  const t = LOUDNESS_TARGET;
  return [
    '-hide_banner',
    '-nostdin',
    '-i',
    wav,
    '-af',
    `loudnorm=I=${t.integrated}:TP=${t.truePeak}:LRA=${t.range}:print_format=json`,
    '-f',
    'null',
    '-',
  ];
}

/**
 * Encoder fed with JPEG frames on stdin (input 0) and the mixed WAV (input 1, normalised by `loudnorm`
 * when there is sound). Output frame count is fixed to the project's; BT.709 tagged; faststart.
 */
export function encodeArgs(opts: {
  fps: Fps;
  frames: number;
  totalSec: number;
  /** The mixed track and its second-pass loudnorm filter (null = leave the level as is). */
  audio: { path: string; loudnorm: string | null } | null;
  preset: RenderPreset;
  out: string;
}): string[] {
  const s = PRESET_SETTINGS[opts.preset];
  const audioIn = opts.audio ? ['-i', opts.audio.path] : [];
  const audioGraph = opts.audio
    ? `[1:a]${opts.audio.loudnorm ? `${opts.audio.loudnorm},` : ''}aresample=48000,${PEAK_LIMITER},atrim=0:${num(opts.totalSec)}[aout]`
    : audioFilterGraph([], opts.totalSec);
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
    ...audioIn,
    '-filter_complex',
    `[0:v]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[vout];${audioGraph}`,
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
