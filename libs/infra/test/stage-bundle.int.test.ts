import { join } from 'node:path';
import { type Browser, chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadStageBundle, type StageBundle } from '../src/render/stage-bundle.js';
import { type StaticServer, serveFiles } from '../src/render/static-server.js';

// Needs Chromium (playwright cache) → run outside the macOS sandbox (Mach-port error inside it).
let bundle: StageBundle;
let server: StaticServer;
let browser: Browser;

beforeAll(async () => {
  bundle = await loadStageBundle();
  const files = new Map(Object.keys(bundle.manifest.files).map((p) => [`/${p}`, join(bundle.dir, p)]));
  server = await serveFiles(files);
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const project = {
  schemaVersion: 1,
  id: uuid(1),
  merchantId: uuid(2),
  fps: { num: 30, den: 1 },
  width: 1080,
  height: 1920,
  durationFrames: 60,
  assets: {},
  tracks: [{ id: uuid(3), kind: 'overlay', elementIds: [uuid(4), uuid(5)] }],
  elements: {
    [uuid(4)]: {
      type: 'shape',
      id: uuid(4),
      trackId: uuid(3),
      startFrame: 0,
      durationFrames: 30,
      origin: 'user',
      shape: 'rect',
      width: 400,
      height: 400,
      fill: '#ff0000',
      transform: { x: 0, y: -500, scale: 1, rotation: 0 },
    },
    [uuid(5)]: {
      type: 'text',
      id: uuid(5),
      trackId: uuid(3),
      startFrame: 30,
      durationFrames: 30,
      origin: 'user',
      content: 'ราคาพิเศษ ฿399',
      styleRef: 'title',
      transform: { x: 0, y: 0, scale: 1, rotation: 0 },
    },
  },
  meta: { createdBy: 'user' },
};

describe('stage bundle in a blank headless page', () => {
  it('loads, draws frames and uses the bundled Thai font', async () => {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${server.url}/index.html`);
    // page-side code: the backend compiles without DOM types, so the page globals go through `g`
    const api = await page.evaluate(() => {
      const g = globalThis as any;
      return ['mountStage', 'render', 'buildCaptions', 'frameState'].map((k) => typeof g.MyVideoStage?.[k]);
    });
    expect(api).toEqual(['function', 'object', 'function', 'function']);

    await page.evaluate((p) => (globalThis as any).MyVideoStage.render.load(p, {}), project);
    await page.evaluate(() => (globalThis as any).MyVideoStage.render.seek(10));
    const rect = await page.screenshot({ clip: { x: 540, y: 460, width: 1, height: 1 } });
    await page.evaluate(() => (globalThis as any).MyVideoStage.render.seek(40));
    const text = await page.evaluate(() => {
      const g = globalThis as any;
      return {
        thai: g.document.fonts.check('800 88px "Noto Sans Thai Variable"', 'ราคา') as boolean,
        visible: [...g.document.querySelectorAll('[data-el]')].map((e: any) => e.style.visibility as string),
      };
    });
    const png = await page.screenshot({ clip: { x: 540, y: 460, width: 1, height: 1 } });
    await page.close();

    expect(errors).toEqual([]);
    expect(text.thai).toBe(true);
    expect(text.visible).toEqual(['hidden', 'visible']); // frame 40: rect gone, text shown
    // red rect centre (540, 960-500) at frame 10, black there at frame 40
    expect(await pixel(rect)).toEqual([255, 0, 0]);
    expect(await pixel(png)).toEqual([0, 0, 0]);
  });
});

/** RGB of a 1×1 PNG screenshot, decoded by the page's own canvas (no image library in the backend). */
async function pixel(png: Buffer): Promise<number[]> {
  const page = await browser.newPage();
  const rgb = await page.evaluate(async (b64) => {
    const g = globalThis as any;
    const img = new g.Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = g.document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)] as number[];
  }, png.toString('base64'));
  await page.close();
  return rgb;
}
