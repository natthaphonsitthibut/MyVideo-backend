/** Recipe version of the preview proxy. Bump when the arguments change: old proxies stay valid for old rows. */
export const PROXY_RECIPE = 1;
export const PROXY_FPS = 30;
export const PROXY_SHORT_SIDE = 540;

export type ProxyEncoder = 'libx264' | 'h264_videotoolbox';

/** Scale so the SHORT side is ≤ 540 (never upscale), keep aspect, even dimensions, constant 30 fps. */
export const proxyVideoFilter =
  `scale=w='if(gt(iw,ih),-2,min(${PROXY_SHORT_SIDE},iw))':h='if(gt(iw,ih),min(${PROXY_SHORT_SIDE},ih),-2)',` +
  `fps=${PROXY_FPS},format=yuv420p`;

export type Segment = { index: number; start: number; duration: number };

/** Splits [0, duration) into segments; short inputs are one segment. */
export function planSegments(durationSec: number, segmentSec: number): Segment[] {
  if (durationSec <= segmentSec * 1.5) return [{ index: 0, start: 0, duration: durationSec }];
  const out: Segment[] = [];
  for (let i = 0, start = 0; start < durationSec - 1e-6; i++, start += segmentSec) {
    const duration = Math.min(segmentSec, durationSec - start);
    if (duration < 0.5 && out.length) {
      const last = out[out.length - 1];
      if (last) last.duration += duration; // fold a tiny tail into the previous part
      break;
    }
    out.push({ index: i, start, duration });
  }
  return out;
}

const encoderArgs = (enc: ProxyEncoder) =>
  enc === 'h264_videotoolbox'
    ? ['-c:v', 'h264_videotoolbox', '-b:v', '1500k', '-realtime', 'false']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26'];

/**
 * One video-only part (frame-accurate: -ss before -i with re-encode, keyframe every 15 frames). A photo
 * (`still`) is looped into a still clip of `seg.duration` instead.
 */
export function segmentArgs(
  input: string,
  seg: Segment,
  out: string,
  enc: ProxyEncoder,
  still = false,
): string[] {
  const source = still
    ? ['-loop', '1', '-framerate', String(PROXY_FPS), '-t', seg.duration.toFixed(3), '-i', input]
    : ['-ss', seg.start.toFixed(3), '-t', seg.duration.toFixed(3), '-i', input];
  return [
    '-v',
    'error',
    '-y',
    '-nostdin',
    ...source,
    '-map',
    '0:v:0',
    '-an',
    '-sn',
    '-dn',
    '-vf',
    proxyVideoFilter,
    ...encoderArgs(enc),
    '-g',
    '15',
    '-keyint_min',
    '15',
    '-sc_threshold',
    '0',
    '-bf',
    '0',
    '-progress',
    'pipe:1',
    '-nostats',
    out,
  ];
}

/** Whole audio track in one pass (no drift at segment joins). */
export function audioArgs(input: string, out: string): string[] {
  return [
    '-v',
    'error',
    '-y',
    '-nostdin',
    '-i',
    input,
    '-map',
    '0:a:0',
    '-vn',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-ac',
    '2',
    '-ar',
    '48000',
    '-progress',
    'pipe:1',
    '-nostats',
    out,
  ];
}

/** Joins parts (stream copy) and the audio track into the final web-optimised proxy. */
export function concatArgs(listFile: string, audio: string | null, out: string): string[] {
  return [
    '-v',
    'error',
    '-y',
    '-nostdin',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listFile,
    ...(audio ? ['-i', audio, '-map', '0:v:0', '-map', '1:a:0'] : ['-map', '0:v:0']),
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    '-shortest',
    out,
  ];
}
