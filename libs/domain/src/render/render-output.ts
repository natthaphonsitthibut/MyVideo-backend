/** Loudness target for exports: −14 LUFS integrated / −1.5 dBTP (what the short-video platforms normalise to). */
export const LOUDNESS_TARGET = { integrated: -14, truePeak: -1.5, range: 11 } as const;

/** ffmpeg `loudnorm` measurement (first pass, `print_format=json`). */
export type LoudnessMeasure = {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
};

/**
 * Second-pass `loudnorm` with the measured values and `linear=true` (one gain for the whole clip, no pumping).
 * Returns null when there is nothing to normalise (silence measures −inf).
 */
export function loudnormFilter(m: LoudnessMeasure): string | null {
  const i = Number(m.input_i);
  if (!Number.isFinite(i) || i < -70) return null;
  const t = LOUDNESS_TARGET;
  return (
    `loudnorm=I=${t.integrated}:TP=${t.truePeak}:LRA=${t.range}` +
    `:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}` +
    `:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true:print_format=summary`
  );
}

/** Parses the JSON block ffmpeg's loudnorm prints at the end of stderr. */
export function parseLoudnorm(stderr: string): LoudnessMeasure {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no loudnorm measurement in ffmpeg output');
  const j = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
  for (const k of ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'])
    if (typeof j[k] !== 'string') throw new Error(`loudnorm measurement lacks ${k}`);
  return j as unknown as LoudnessMeasure;
}

export type RenderedProbe = {
  video: {
    codec: string;
    width: number;
    height: number;
    frames: number;
    startSec: number;
    durationSec: number;
  }[];
  audio: { codec: string; sampleRate: number; startSec: number; durationSec: number }[];
};

/**
 * Validation step of a render (fails the job on a mismatch): exactly one H.264 video stream of the project size
 * with the project's frame count, exactly one AAC stream, both starting together and ending within one frame.
 */
export function checkRenderOutput(
  probe: RenderedProbe,
  expected: { width: number; height: number; frames: number; fps: { num: number; den: number } },
): string[] {
  const frame = expected.fps.den / expected.fps.num;
  const problems: string[] = [];
  if (probe.video.length !== 1) problems.push(`expected 1 video stream, found ${probe.video.length}`);
  if (probe.audio.length !== 1) problems.push(`expected 1 audio stream, found ${probe.audio.length}`);
  const v = probe.video[0];
  const a = probe.audio[0];
  if (v) {
    if (v.codec !== 'h264') problems.push(`video codec ${v.codec}, expected h264`);
    if (v.width !== expected.width || v.height !== expected.height)
      problems.push(`video is ${v.width}×${v.height}, expected ${expected.width}×${expected.height}`);
    if (v.frames !== expected.frames)
      problems.push(`video has ${v.frames} frames, expected ${expected.frames}`);
  }
  if (a) {
    if (a.codec !== 'aac') problems.push(`audio codec ${a.codec}, expected aac`);
    if (a.sampleRate !== 48000) problems.push(`audio sample rate ${a.sampleRate}, expected 48000`);
  }
  if (v && a) {
    const offset = Math.abs(v.startSec - a.startSec);
    if (offset > frame) problems.push(`audio starts ${Math.round(offset * 1000)} ms away from video`);
    const want = expected.frames * frame;
    if (Math.abs(a.durationSec - want) > frame)
      problems.push(`audio lasts ${a.durationSec.toFixed(3)} s, expected ${want.toFixed(3)} s`);
  }
  return problems;
}
