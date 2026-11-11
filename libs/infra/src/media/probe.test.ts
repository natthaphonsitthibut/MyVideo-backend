import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeProbe } from './probe.js';

const fx = (name: string) => {
  const raw = readFileSync(new URL(`../../test/fixtures/probe/${name}.json`, import.meta.url), 'utf8');
  return raw.trim() ? JSON.parse(raw) : null;
};

describe('normalizeProbe (recorded ffprobe output of real footage)', () => {
  it('reads a vertical live clip', () => {
    const r = normalizeProbe(fx('vertical'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.video).toMatchObject({
      width: 406,
      height: 720,
      rotation: 0,
      fps: { num: 30, den: 1 },
      vfr: false,
      codec: 'h264',
    });
    expect(r.info.video.durationFrames).toBe(1500);
    expect(r.info.audio).toMatchObject({ codec: 'aac', sampleRate: 44100, channels: 2 });
    expect(r.info.orientation).toBe('portrait');
  });

  it('reads a horizontal review clip', () => {
    const r = normalizeProbe(fx('horizontal'));
    expect(r.ok && r.info.video).toMatchObject({ width: 1280, height: 720 });
    expect(r.ok && r.info.orientation).toBe('landscape');
  });

  it('applies display rotation (90°) to width and height', () => {
    const r = normalizeProbe(fx('rotated'));
    expect(r.ok && r.info.video).toMatchObject({
      width: 720,
      height: 576,
      codedWidth: 576,
      codedHeight: 720,
      rotation: 90,
    });
  });

  it('flags variable frame rate and normalises to 30 fps', () => {
    const r = normalizeProbe(fx('vfr'));
    expect(r.ok && r.info.video).toMatchObject({ vfr: true, fps: { num: 30, den: 1 } });
    expect(r.ok && r.info.video.durationFrames).toBe(900);
  });

  it('accepts a clip without an audio stream and says so', () => {
    const r = normalizeProbe(fx('silent'));
    expect(r.ok && r.info.audio).toBeNull();
    expect(r.ok && r.info.video.fps).toEqual({ num: 50, den: 1 });
  });

  it('rejects audio-only files with a Thai message', () => {
    const r = normalizeProbe(fx('audio-only'));
    expect(r).toMatchObject({ ok: false, reason: 'no_video' });
    expect(!r.ok && r.messageTh).toMatch(/ไม่มีภาพ/);
  });

  it('rejects a truncated mp4 (packets missing behind a complete header)', () => {
    const r = normalizeProbe(fx('truncated'));
    expect(r).toMatchObject({ ok: false, reason: 'truncated' });
  });

  it('rejects an unreadable file', () => {
    expect(normalizeProbe(fx('text'))).toMatchObject({ ok: false, reason: 'unreadable' });
    expect(normalizeProbe({ format: {}, streams: [] })).toMatchObject({ ok: false, reason: 'unreadable' });
  });

  it('rejects absurd durations and resolutions', () => {
    const base = fx('vertical');
    const long = structuredClone(base);
    long.format.duration = String(5 * 3600);
    for (const s of long.streams) s.duration = String(5 * 3600);
    expect(normalizeProbe(long)).toMatchObject({ ok: false, reason: 'too_long' });
    const huge = structuredClone(base);
    for (const s of huge.streams)
      if (s.codec_type === 'video') Object.assign(s, { width: 7680, height: 4320 });
    expect(normalizeProbe(huge)).toMatchObject({ ok: false, reason: 'too_large' });
  });
});
