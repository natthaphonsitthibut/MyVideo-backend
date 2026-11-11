import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Workspace footage folder (never in this repo). CI has none → callers fall back to a labelled plumbing input. */
export const FOOTAGE_DIR =
  process.env.MYVIDEO_FOOTAGE_DIR ?? fileURLToPath(new URL('../../footage', import.meta.url));

export function footageClip(name: string): string | undefined {
  const p = `${FOOTAGE_DIR}/clips/${name}`;
  return existsSync(p) ? p : undefined;
}
