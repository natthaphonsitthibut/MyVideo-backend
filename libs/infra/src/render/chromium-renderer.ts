import { extname, join } from 'node:path';
import type { Writable } from 'node:stream';
import {
  loudnormFilter,
  parseLoudnorm,
  planRender,
  type RenderOptions,
  type RenderRequest,
  type RenderStats,
  type VideoRenderer,
} from '@myvideo/domain';
import { type BrowserServer, chromium } from 'playwright-core';
import { runProcess, withTempDir } from '../process/run-process.js';
import { cutArgs, encodeArgs, measureArgs, mixArgs } from './render-args.js';
import type { StageBundle } from './stage-bundle.js';
import { serveFiles } from './static-server.js';

export type ChromiumRendererOptions = {
  /** JPEG quality of captured frames (the frames are re-encoded to H.264 anyway). */
  jpegQuality?: number;
  /** Called with the Chromium pid once it runs (tests, memory sampling). */
  onBrowserPid?: (pid: number) => void;
  /** Called with the encoder pid once it runs. */
  onEncoderPid?: (pid: number) => void;
};

/** What the stage bundle puts on the render page (frontend `packages/stage/bundle/entry.ts`). */
type StagePage = {
  MyVideoStage: {
    render: {
      load(project: unknown, urls: unknown): Promise<{ frames: number }>;
      seek(frame: number): Promise<void>;
    };
  };
};

const write = (stream: Writable, chunk: Buffer) =>
  new Promise<void>((resolve, reject) => {
    if (stream.destroyed) return reject(new Error('encoder input closed'));
    if (stream.write(chunk)) return resolve();
    const done = (err?: Error) => {
      stream.off('drain', onDrain);
      stream.off('close', onClose);
      if (err) reject(err);
      else resolve();
    };
    const onDrain = () => done();
    const onClose = () => done(new Error('encoder input closed'));
    stream.on('drain', onDrain);
    stream.on('close', onClose);
  });

/**
 * Render driver (D-018): headless Chromium opens the synced stage bundle on a loopback server, draws every
 * frame with `MyVideoStage.render.seek(frame)` and streams JPEG captures into ffmpeg, which encodes H.264 and
 * mixes the audio from the originals. Media are first cut into all-intra clips so per-frame seeks are cheap.
 * Abort kills Chromium and ffmpeg (process groups) and removes the temp dir.
 */
export class ChromiumRenderer implements VideoRenderer {
  constructor(
    private readonly bundle: StageBundle,
    private readonly opts: ChromiumRendererOptions = {},
  ) {}

  get stageVersion(): string {
    return this.bundle.version;
  }

  async render(req: RenderRequest, { signal, onProgress }: RenderOptions): Promise<RenderStats> {
    const started = Date.now();
    const plan = planRender(req.project);
    const { fps, width, height, durationFrames } = plan.project;
    const report = (v: number) => onProgress?.(Math.min(1, Math.max(0, v)));
    return withTempDir('render', async (dir) => {
      // 1. all-intra cuts of every video range (10 % of progress)
      const files = new Map<string, string>(
        Object.keys(this.bundle.manifest.files).map((p) => [`/${p}`, join(this.bundle.dir, p)]),
      );
      const urls: Record<string, string> = {};
      for (const [i, cut] of plan.cuts.entries()) {
        const src = req.media[cut.sourceAssetId];
        if (!src) throw new Error(`no media file for asset ${cut.sourceAssetId}`);
        const out = join(dir, `${cut.assetId}.mp4`);
        await runProcess('ffmpeg', cutArgs(src, cut, fps, out), { signal });
        files.set(`/media/${cut.assetId}.mp4`, out);
        urls[cut.assetId] = `/media/${cut.assetId}.mp4`;
        report((0.1 * (i + 1)) / plan.cuts.length);
      }
      for (const id of Object.keys(plan.project.assets)) {
        if (urls[id]) continue;
        const src = req.media[id];
        if (!src) throw new Error(`no media file for asset ${id}`);
        const path = `/media/${id}${extname(src).toLowerCase()}`;
        files.set(path, src);
        urls[id] = path;
      }
      // 2. audio: mix every clip to one WAV, measure EBU R128, normalise in the encode (linear loudnorm)
      let mixed: { path: string; loudnorm: string | null } | null = null;
      if (plan.audio.length > 0) {
        const clips = plan.audio.map((a) => {
          const path = req.media[a.sourceAssetId];
          if (!path) throw new Error(`no media file for asset ${a.sourceAssetId}`);
          return { ...a, path };
        });
        const wav = join(dir, 'mix.wav');
        await runProcess('ffmpeg', mixArgs(clips, plan.totalSec, wav), { signal });
        const measured = await runProcess('ffmpeg', measureArgs(wav), { signal });
        mixed = { path: wav, loudnorm: loudnormFilter(parseLoudnorm(measured.stderrTail)) };
      }
      const prepareMs = Date.now() - started;

      // 3. Chromium + encoder
      const server = await serveFiles(files);
      let browser: BrowserServer | undefined;
      const kill = () => void browser?.kill();
      signal.addEventListener('abort', kill, { once: true });
      let stdin: Writable | undefined;
      let encoder: Promise<unknown> | undefined;
      const captureStart = Date.now();
      try {
        if (signal.aborted) throw signal.reason;
        browser = await chromium.launchServer({ headless: true, args: ['--mute-audio'] });
        const pid = browser.process().pid;
        if (pid) this.opts.onBrowserPid?.(pid);
        if (signal.aborted) throw signal.reason;
        const client = await chromium.connect(browser.wsEndpoint());
        const page = await client.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
        const pageErrors: string[] = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));
        await page.goto(`${server.url}/index.html`);
        await page.evaluate(([p, u]) => (globalThis as unknown as StagePage).MyVideoStage.render.load(p, u), [
          plan.project,
          urls,
        ] as const);
        encoder = runProcess(
          'ffmpeg',
          encodeArgs({
            fps,
            frames: durationFrames,
            totalSec: plan.totalSec,
            audio: mixed,
            preset: req.preset,
            out: req.outPath,
          }),
          {
            signal,
            onStdin: (s) => {
              stdin = s;
            },
            onSpawn: (p) => this.opts.onEncoderPid?.(p),
          },
        );
        encoder.catch(() => {}); // awaited below; avoid an unhandled rejection while frames are captured
        const quality = this.opts.jpegQuality ?? 92;
        for (let f = 0; f < durationFrames; f++) {
          if (signal.aborted) throw signal.reason;
          await page.evaluate(
            (frame) => (globalThis as unknown as StagePage).MyVideoStage.render.seek(frame),
            f,
          );
          const jpeg = await page.screenshot({ type: 'jpeg', quality });
          if (!stdin) throw new Error('encoder did not start');
          await write(stdin, jpeg);
          report(0.1 + (0.88 * (f + 1)) / durationFrames);
        }
        if (pageErrors.length) throw new Error(`stage page error: ${pageErrors[0]}`);
        stdin?.end();
        await encoder;
        report(1);
        return {
          frames: durationFrames,
          prepareMs,
          captureMs: Date.now() - captureStart,
          totalMs: Date.now() - started,
          stageVersion: this.bundle.version,
        };
      } catch (err) {
        stdin?.destroy();
        await encoder?.catch(() => {});
        throw signal.aborted ? (signal.reason ?? err) : err;
      } finally {
        signal.removeEventListener('abort', kill);
        await browser?.close().catch(() => browser?.kill());
        await server.close();
      }
    });
  }
}
