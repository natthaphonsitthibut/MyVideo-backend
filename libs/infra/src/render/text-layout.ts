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
    opts: {
      measure: (t: string) => number;
      maxWidth: number;
      maxLines: number;
      pauseFrames: number;
      maxWords?: number;
    },
  ): LaidOutCaptionPage[];
  phraseTokens(text: string): string[];
  balancedLines(
    tokens: readonly string[],
    measure: (t: string) => number,
    maxWidth: number,
    maxLines: number,
  ): string[] | null;
  canvasMeasure(font: string): (t: string) => number;
  captionFont(styleRef: string): string;
  captionMaxWidth(canvasWidth: number, styleRef?: string): number;
  lintCaptionLines(words: readonly LayoutWord[], lines: readonly (readonly number[])[]): string[];
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
    opts: {
      styleRef: string;
      canvasWidth: number;
      maxLines?: number;
      pauseFrames?: number;
      maxWords?: number;
    },
  ): Promise<LaidOutCaptionPage[]> {
    return this.page.evaluate(
      async ([w, o]) => {
        const s = (globalThis as unknown as StagePage).MyVideoStage;
        const font = s.captionFont(o.styleRef);
        await s.loadCaptionFont(font);
        const pages = s.buildCaptions(w, {
          measure: s.canvasMeasure(font),
          // the style matters: a boxed caption loses its padding from the line width
          maxWidth: o.styleRef === 'word-stack' ? 1 : s.captionMaxWidth(o.canvasWidth, o.styleRef),
          maxLines: o.maxLines ?? 2,
          pauseFrames: o.pauseFrames ?? 15,
          ...(o.maxWords !== undefined ? { maxWords: o.maxWords } : {}),
        });
        for (const page of pages) {
          const errors = s.lintCaptionLines(page.words, page.lines);
          if (errors.length) throw new Error(`Invalid Thai captions: ${errors.join(',')}`);
        }
        return pages;
      },
      [words, opts] as const,
    );
  }

  /**
   * Line breaks for free text (hook, end card) with the stage's phrase rules: breaks only between phrases (never
   * inside "number + what it counts" or a Latin name), fewest lines, then the most even split. Tries the font sizes
   * from the largest down until it fits `maxLines` lines of `maxWidth`.
   */
  layoutText(
    text: string,
    opts: { fontWeight: number; fontSizes: number[]; maxWidth: number; maxLines: number },
  ): Promise<LaidOutText> {
    return this.page.evaluate(
      async ([t, o]) => {
        const s = (globalThis as unknown as StagePage).MyVideoStage;
        const tokens = s.phraseTokens(t);
        for (const size of o.fontSizes) {
          const font = `${o.fontWeight} ${size}px ${s.STAGE_FONT}`;
          await s.loadCaptionFont(font);
          const lines = s.balancedLines(tokens, s.canvasMeasure(font), o.maxWidth, o.maxLines);
          if (lines) return { text: lines.join('\n'), fontSize: size, lines: lines.length };
        }
        // nothing fits: smallest size, keep the leading phrases that fit (real S01a: a five-phrase AI title became a
        // five-line end card over the call-to-action). Never cut inside a phrase; the merchant can edit the text.
        const size = o.fontSizes.at(-1) ?? 48;
        const font = `${o.fontWeight} ${size}px ${s.STAGE_FONT}`;
        for (let n = tokens.length - 1; n >= 1; n--) {
          const lines = s.balancedLines(tokens.slice(0, n), s.canvasMeasure(font), o.maxWidth, o.maxLines);
          if (lines) return { text: lines.join('\n'), fontSize: size, lines: lines.length };
        }
        return { text: tokens[0] ?? t, fontSize: size, lines: 1 };
      },
      [text, opts] as const,
    );
  }

  async close(): Promise<void> {
    await this.browser.close().catch(() => undefined);
    await this.server.close();
  }
}
