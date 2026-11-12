import { join } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright-core';
import type { StageBundle } from './stage-bundle.js';
import { type StaticServer, serveFiles } from './static-server.js';

/** Caption words in project frames, relative to the clip start (stage `TimedWord`). */
export type LayoutWord = { text: string; startFrame: number; endFrame: number };
export type LaidOutCaptionPage = {
  startFrame: number;
  durationFrames: number;
  words: LayoutWord[];
  lines: number[][];
};
export type LaidOutText = { text: string; fontSize: number; lines: number };

/** What the stage bundle page exposes (subset used here). */
type StageLib = {
  buildCaptions(
    words: LayoutWord[],
    opts: { measure: (t: string) => number; maxWidth: number; maxLines: number; pauseFrames: number },
  ): LaidOutCaptionPage[];
  canvasMeasure(font: string): (t: string) => number;
  captionFont(styleRef: string): string;
  captionMaxWidth(canvasWidth: number): number;
  loadCaptionFont(font: string): Promise<void>;
  STAGE_FONT: string;
};
type StagePage = { MyVideoStage: StageLib };

/**
 * Text layout with the stage's own code and bundled fonts (ARCHITECTURE §7: one compositor): captions use the
 * stage caption builder measured with the caption font, exactly as the editor does when a user creates a clip;
 * free text (a hook) gets explicit line breaks at spaces so the stage's `pre-wrap` never breaks Thai mid-word.
 * One headless Chromium page per instance; close it when done.
 */
export class StageTextLayout {
  private constructor(
    private readonly browser: Browser,
    private readonly page: Page,
    private readonly server: StaticServer,
  ) {}

  static async open(bundle: StageBundle): Promise<StageTextLayout> {
    const files = new Map<string, string>(
      Object.keys(bundle.manifest.files).map((p) => [`/${p}`, join(bundle.dir, p)]),
    );
    const server = await serveFiles(files);
    const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
    try {
      const page = await browser.newPage();
      await page.goto(`${server.url}/index.html`);
      return new StageTextLayout(browser, page, server);
    } catch (err) {
      await browser.close();
      await server.close();
      throw err;
    }
  }

  layoutCaptions(
    words: LayoutWord[],
    opts: { styleRef: string; canvasWidth: number; maxLines?: number; pauseFrames?: number },
  ): Promise<LaidOutCaptionPage[]> {
    return this.page.evaluate(
      async ([w, o]) => {
        const s = (globalThis as unknown as StagePage).MyVideoStage;
        const font = s.captionFont(o.styleRef);
        await s.loadCaptionFont(font);
        return s.buildCaptions(w, {
          measure: s.canvasMeasure(font),
          maxWidth: s.captionMaxWidth(o.canvasWidth),
          maxLines: o.maxLines ?? 2,
          pauseFrames: o.pauseFrames ?? 15,
        });
      },
      [words, opts] as const,
    );
  }

  /**
   * Greedy line fill of `text` at its spaces, measured with the stage font. Tries the given font sizes from the
   * largest down until every space-separated phrase fits `maxWidth` and there are at most `maxLines` lines.
   */
  layoutText(
    text: string,
    opts: { fontWeight: number; fontSizes: number[]; maxWidth: number; maxLines: number },
  ): Promise<LaidOutText> {
    return this.page.evaluate(
      async ([t, o]) => {
        const s = (globalThis as unknown as StagePage).MyVideoStage;
        const tokens = t.split(/\s+/).filter((x) => x.length > 0);
        let last = { text: tokens.join(' '), fontSize: o.fontSizes.at(-1) ?? 48, lines: 1 };
        for (const size of o.fontSizes) {
          const font = `${o.fontWeight} ${size}px ${s.STAGE_FONT}`;
          await s.loadCaptionFont(font);
          const width = s.canvasMeasure(font);
          const lines: string[] = [];
          let ok = true;
          for (const tok of tokens) {
            if (width(tok) > o.maxWidth) ok = false;
            const cur = lines.at(-1);
            const joined = cur === undefined ? tok : `${cur} ${tok}`;
            if (cur !== undefined && width(joined) <= o.maxWidth) lines[lines.length - 1] = joined;
            else lines.push(tok);
          }
          last = { text: lines.join('\n'), fontSize: size, lines: lines.length };
          if (ok && lines.length <= o.maxLines) return last;
        }
        return last;
      },
      [text, opts] as const,
    );
  }

  async close(): Promise<void> {
    await this.browser.close().catch(() => undefined);
    await this.server.close();
  }
}
