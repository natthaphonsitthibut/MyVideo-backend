import { describe, expect, it } from 'vitest';
import { audioArgs, concatArgs, planSegments, proxyVideoFilter, segmentArgs } from './proxy.js';

describe('planSegments', () => {
  it('keeps short inputs whole', () => {
    expect(planSegments(54.5, 300)).toEqual([{ index: 0, start: 0, duration: 54.5 }]);
    expect(planSegments(449, 300)).toHaveLength(1);
  });
  it('splits long inputs into covering, non-overlapping parts', () => {
    const segs = planSegments(2700, 300);
    expect(segs).toHaveLength(9);
    expect(segs.reduce((a, s) => a + s.duration, 0)).toBeCloseTo(2700, 6);
    for (const [i, s] of segs.entries()) expect(s.start).toBeCloseTo(i * 300, 6);
  });
  it('folds a tiny tail into the last part', () => {
    const segs = planSegments(600.2, 300);
    expect(segs).toHaveLength(2);
    expect(segs[1]?.duration).toBeCloseTo(300.2, 6);
  });
});

describe('ffmpeg argument builders', () => {
  it('loops a photo into a still proxy of the given length (no seek, same filter and GOP)', () => {
    const a = segmentArgs('/in/p.jpg', { index: 0, start: 0, duration: 5 }, '/out/p0.mp4', 'libx264', true);
    const i = a.indexOf('-i');
    expect(a.slice(i - 6, i + 2)).toEqual([
      '-loop',
      '1',
      '-framerate',
      '30',
      '-t',
      '5.000',
      '-i',
      '/in/p.jpg',
    ]);
    expect(a).not.toContain('-ss');
    expect(a[a.indexOf('-vf') + 1]).toBe(proxyVideoFilter);
    expect(a[a.indexOf('-g') + 1]).toBe('15');
  });

  it('never use a shell string and keep the proxy contract (30 fps, GOP 15, faststart)', () => {
    const a = segmentArgs('/in/a b.mp4', { index: 0, start: 300, duration: 300 }, '/out/p0.mp4', 'libx264');
    expect(a).toContain('/in/a b.mp4'); // spaces stay inside one argument
    expect(a.slice(a.indexOf('-ss'), a.indexOf('-ss') + 4)).toEqual(['-ss', '300.000', '-t', '300.000']);
    expect(a).toEqual(expect.arrayContaining(['-g', '15', '-keyint_min', '15', '-an']));
    expect(proxyVideoFilter).toContain('fps=30');
    expect(concatArgs('/l.txt', '/a.m4a', '/p.mp4')).toEqual(
      expect.arrayContaining(['-movflags', '+faststart', '-c', 'copy']),
    );
    expect(concatArgs('/l.txt', null, '/p.mp4')).not.toContain('1:a:0');
    expect(audioArgs('/in.mp4', '/a.m4a')).toEqual(expect.arrayContaining(['-c:a', 'aac', '-ac', '2']));
  });
});
