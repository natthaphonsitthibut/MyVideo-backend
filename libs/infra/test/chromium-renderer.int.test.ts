import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAlive, probeOutput, S01_PATH, s01Project, sampleTreeRss } from '../../../test/render-helpers.js';
import { ChromiumRenderer } from '../src/render/chromium-renderer.js';
import { loadStageBundle } from '../src/render/stage-bundle.js';

// Real footage (S01) + Chromium → outside the sandbox, on a machine with the footage folder.
let out: string;
beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), 'myvideo-render-test-'));
});
afterAll(() => rm(out, { recursive: true, force: true }));

const renderTmpDirs = async () => (await readdir(tmpdir())).filter((d) => d.startsWith('myvideo-render-'));

describe.skipIf(!S01_PATH)('ChromiumRenderer on a real 15 s project', () => {
  it('renders a valid 1080×1920 30 fps MP4 with AAC audio and the exact frame count', async () => {
    const project = s01Project(450);
    const asset = Object.keys(project.assets)[0] as string;
    const renderer = new ChromiumRenderer(await loadStageBundle());
    const mem = sampleTreeRss(process.pid);
    const progress: number[] = [];
    const file = join(out, 'a.mp4');
    const stats = await renderer.render(
      { project, media: { [asset]: S01_PATH as string }, preset: 'standard', outPath: file },
      { signal: new AbortController().signal, onProgress: (v) => progress.push(v) },
    );
    const peakMb = await mem.stop();
    const probe = await probeOutput(file);
    console.log('render 15 s:', JSON.stringify({ ...stats, peakMb, probe }));

    expect(probe.video).toMatchObject({ codec: 'h264', width: 1080, height: 1920, fps: '30/1' });
    expect(Math.abs(probe.video.frames - 450)).toBeLessThanOrEqual(1);
    expect(probe.audio).toMatchObject({ codec: 'aac', sampleRate: 48000, channels: 2 });
    expect(Math.abs((probe.audio?.durationSec ?? 0) - 15)).toBeLessThan(0.05);
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((v, i) => i === 0 || v >= (progress[i - 1] as number))).toBe(true);
    expect(stats.stageVersion).toMatch(/^[0-9a-f]{12}$/);
  }, 600_000);

  it('cancel mid-render kills Chromium and ffmpeg and removes the temp dir', async () => {
    const project = s01Project(450);
    const asset = Object.keys(project.assets)[0] as string;
    const pids: { browser?: number; encoder?: number } = {};
    const renderer = new ChromiumRenderer(await loadStageBundle(), {
      onBrowserPid: (p) => {
        pids.browser = p;
      },
      onEncoderPid: (p) => {
        pids.encoder = p;
      },
    });
    const before = await renderTmpDirs();
    const ac = new AbortController();
    const run = renderer.render(
      { project, media: { [asset]: S01_PATH as string }, preset: 'standard', outPath: join(out, 'b.mp4') },
      {
        signal: ac.signal,
        onProgress: (v) => {
          if (v > 0.3 && !ac.signal.aborted) ac.abort(new Error('cancelled by test'));
        },
      },
    );
    await expect(run).rejects.toThrow('cancelled by test');
    expect(pids.browser).toBeGreaterThan(0);
    expect(pids.encoder).toBeGreaterThan(0);
    // process-group kill has a 2 s grace before SIGKILL
    await new Promise((r) => setTimeout(r, 2500));
    expect(isAlive(pids.browser as number)).toBe(false);
    expect(isAlive(pids.encoder as number)).toBe(false);
    expect(await renderTmpDirs()).toEqual(before);
  }, 600_000);
});
