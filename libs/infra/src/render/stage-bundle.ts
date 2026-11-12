import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type StageBundleManifest = {
  name: string;
  version: string;
  files: Record<string, { sha256: string; size: number }>;
};

/** A verified copy of the frontend stage build (ARCHITECTURE §3): what render jobs load and record. */
export type StageBundle = { version: string; dir: string; manifest: StageBundleManifest };

export class StageBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StageBundleError';
  }
}

/** `backend/stage-bundle` (same depth from `src/render` and `dist/render`). */
export const defaultStageBundleRoot = (): string =>
  fileURLToPath(new URL('../../../../stage-bundle', import.meta.url));

/** Same rule as the frontend's `scripts/manifest.mjs`: first 12 hex of sha256 over sorted `path sha256\n`. */
export function manifestVersion(files: StageBundleManifest['files']): string {
  const lines = Object.keys(files)
    .sort()
    .map((p) => `${p} ${files[p]?.sha256}\n`)
    .join('');
  return createHash('sha256').update(lines).digest('hex').slice(0, 12);
}

/**
 * Loads `root/CURRENT` → `root/<version>/manifest.json` and checks every file's size and sha256 and the
 * version itself, so a render never runs a stage that differs from what was synced.
 */
export async function loadStageBundle(root: string = defaultStageBundleRoot()): Promise<StageBundle> {
  const version = (await readFile(join(root, 'CURRENT'), 'utf8').catch(() => '')).trim();
  if (!/^[0-9a-f]{12}$/.test(version))
    throw new StageBundleError(`no stage bundle in ${root} — run ./scripts/sync-contracts.sh`);
  const dir = join(root, version);
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as StageBundleManifest;
  if (manifest.version !== version)
    throw new StageBundleError(`stage bundle manifest says ${manifest.version}, CURRENT says ${version}`);
  if (manifestVersion(manifest.files) !== version)
    throw new StageBundleError(`stage bundle ${version}: manifest checksums do not match its version`);
  for (const [path, want] of Object.entries(manifest.files)) {
    const bytes = await readFile(join(dir, path)).catch(() => null);
    if (!bytes) throw new StageBundleError(`stage bundle ${version}: missing ${path}`);
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (bytes.byteLength !== want.size || sha !== want.sha256)
      throw new StageBundleError(`stage bundle ${version}: ${path} does not match its checksum`);
  }
  return { version, dir, manifest };
}
