import type { RenderProject } from './render-plan.js';

/** Export presets (ARCHITECTURE §7). Encode details live in the adapter; the domain only names them. */
export const RENDER_PRESETS = ['standard', 'high'] as const;
export type RenderPreset = (typeof RENDER_PRESETS)[number];

export type RenderRequest = {
  /** A validated Project JSON (the render job pins its version). */
  project: RenderProject;
  /** Asset id → local path of the ORIGINAL file (renders read originals, ARCHITECTURE §8). */
  media: Record<string, string>;
  preset: RenderPreset;
  /** Where the MP4 is written. */
  outPath: string;
};

export type RenderStats = {
  frames: number;
  prepareMs: number;
  captureMs: number;
  totalMs: number;
  stageVersion: string;
};

export type RenderOptions = {
  /** Abort = stop now and kill every child process (Chromium, ffmpeg). */
  signal: AbortSignal;
  /** 0..1 */
  onProgress?: (value: number) => void;
};

/**
 * Port for the renderer (ARCHITECTURE §7: `validate, render, cancel, progress`): validation is the contracts
 * validator before this is called, cancel is the abort signal, progress is the callback.
 */
export interface VideoRenderer {
  readonly stageVersion: string;
  render(req: RenderRequest, opts: RenderOptions): Promise<RenderStats>;
}
