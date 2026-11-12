import { describe, expect, it } from 'vitest';
import { cutArgs, encodeArgs, measureArgs, mixArgs, PEAK_LIMITER } from './render-args.js';

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('cutArgs', () => {
  it('seeks accurately, keeps the project fps, makes every frame a keyframe and adds two spare frames', () => {
    const a = cutArgs(
      '/in.mp4',
      { assetId: 'x', sourceAssetId: 'y', startSec: 722.233333333, durationSec: 10 },
      { num: 30000, den: 1001 },
      '/o.mp4',
    );
    expect(after(a, '-ss')).toBe('722.233333');
    expect(a.indexOf('-ss')).toBeLessThan(a.indexOf('-i'));
    expect(after(a, '-t')).toBe(String(Math.round((10 + 2 * (1001 / 30000)) * 1e6) / 1e6));
    expect(after(a, '-vf')).toBe('fps=30000/1001,format=yuv420p');
    expect(after(a, '-x264-params')).toBe('keyint=1');
    expect(a).toContain('-an');
    expect(a.at(-1)).toBe('/o.mp4');
  });
});

const clip = {
  sourceAssetId: 's',
  path: '/orig.mp4',
  startSec: 1.5,
  durationSec: 10,
  delaySec: 0,
  rate: 1,
  volume: 1,
};

describe('mixArgs / measureArgs', () => {
  it('cuts each clip on its input and mixes to 48 kHz stereo PCM of the project length', () => {
    const a = mixArgs([clip, { ...clip, path: '/b.mp4', startSec: 0, delaySec: 2 }], 15, '/mix.wav');
    expect(a.join(' ')).toContain('-ss 1.5 -t 10 -i /orig.mp4 -ss 0 -t 10 -i /b.mp4');
    expect(after(a, '-filter_complex')).toContain('[0:a]aresample=48000');
    expect(after(a, '-filter_complex')).toContain('[1:a]aresample=48000');
    expect(after(a, '-filter_complex')).toContain('adelay=2000:all=1');
    expect(after(a, '-filter_complex')).toContain('atrim=0:15');
    expect(after(a, '-c:a')).toBe('pcm_s16le');
  });

  it('measures against the export target', () => {
    expect(after(measureArgs('/mix.wav'), '-af')).toBe('loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json');
  });
});

describe('encodeArgs', () => {
  it('reads JPEG frames from stdin, normalises the mix, fixes frame count, tags BT.709', () => {
    const a = encodeArgs({
      fps: { num: 30, den: 1 },
      frames: 450,
      totalSec: 15,
      audio: { path: '/mix.wav', loudnorm: 'loudnorm=I=-14:linear=true' },
      preset: 'high',
      out: '/out.mp4',
    });
    expect(a.slice(a.indexOf('-f'), a.indexOf('pipe:0') + 1)).toEqual([
      '-f',
      'image2pipe',
      '-c:v',
      'mjpeg',
      '-framerate',
      '30/1',
      '-i',
      'pipe:0',
    ]);
    expect(a.join(' ')).toContain('-i pipe:0 -i /mix.wav');
    expect(after(a, '-filter_complex')).toContain(
      `[1:a]loudnorm=I=-14:linear=true,aresample=48000,${PEAK_LIMITER},atrim=0:15[aout]`,
    );
    expect(after(a, '-frames:v')).toBe('450');
    expect(after(a, '-crf')).toBe('16');
    expect(after(a, '-colorspace')).toBe('bt709');
    expect(a).not.toContain('-nostdin'); // stdin carries the frames
  });

  it('makes a silent track when nothing has sound', () => {
    const a = encodeArgs({
      fps: { num: 30, den: 1 },
      frames: 30,
      totalSec: 1,
      audio: null,
      preset: 'standard',
      out: '/o',
    });
    expect(after(a, '-filter_complex')).toContain('anullsrc=r=48000:cl=stereo,atrim=0:1[aout]');
    expect(after(a, '-crf')).toBe('20');
  });
});
