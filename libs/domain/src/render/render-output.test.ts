import { describe, expect, it } from 'vitest';
import { LOUDNORM_STDERR as STDERR } from './loudnorm-stderr.fixture.js';
import { checkRenderOutput, loudnormFilter, parseLoudnorm, type RenderedProbe } from './render-output.js';

describe('loudness', () => {
  it('parses the measurement and builds a linear second pass', () => {
    const m = parseLoudnorm(STDERR);
    expect(m.input_i).toBe('-17.59');
    expect(loudnormFilter(m)).toBe(
      'loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=-17.59:measured_TP=-0.78:measured_LRA=4.80:measured_thresh=-27.69:offset=0.27:linear=true:print_format=summary',
    );
  });

  it('leaves silence alone', () => {
    expect(loudnormFilter({ ...parseLoudnorm(STDERR), input_i: '-inf' })).toBeNull();
    expect(loudnormFilter({ ...parseLoudnorm(STDERR), input_i: '-90.00' })).toBeNull();
  });

  it('refuses output without a measurement', () => {
    expect(() => parseLoudnorm('size=N/A time=00:00:15.00')).toThrow(/no loudnorm/);
  });
});

describe('checkRenderOutput', () => {
  const fps = { num: 30, den: 1 };
  const ok: RenderedProbe = {
    video: [{ codec: 'h264', width: 1080, height: 1920, frames: 450, startSec: 0, durationSec: 15 }],
    audio: [{ codec: 'aac', sampleRate: 48000, startSec: 0, durationSec: 15.0213 }],
  };
  const expected = { width: 1080, height: 1920, frames: 450, fps };

  it('accepts a matching file (AAC priming within a frame)', () => {
    expect(checkRenderOutput(ok, expected)).toEqual([]);
  });

  it('names every mismatch', () => {
    const bad: RenderedProbe = {
      video: [{ codec: 'hevc', width: 1080, height: 1080, frames: 449, startSec: 0, durationSec: 14.97 }],
      audio: [{ codec: 'mp3', sampleRate: 44100, startSec: 0.1, durationSec: 14.5 }],
    };
    expect(checkRenderOutput(bad, expected)).toEqual([
      'video codec hevc, expected h264',
      'video is 1080×1080, expected 1080×1920',
      'video has 449 frames, expected 450',
      'audio codec mp3, expected aac',
      'audio sample rate 44100, expected 48000',
      'audio starts 100 ms away from video',
      'audio lasts 14.500 s, expected 15.000 s',
    ]);
  });

  it('requires exactly one stream of each kind', () => {
    expect(checkRenderOutput({ video: ok.video, audio: [] }, expected)).toEqual([
      'expected 1 audio stream, found 0',
    ]);
  });
});
