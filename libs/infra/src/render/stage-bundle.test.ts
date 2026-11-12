import { appendFile, cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultStageBundleRoot,
  loadStageBundle,
  manifestVersion,
  StageBundleError,
} from './stage-bundle.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'myvideo-stage-bundle-test-'));
  await cp(defaultStageBundleRoot(), root, { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('loadStageBundle', () => {
  it('loads the synced bundle and verifies every file', async () => {
    const b = await loadStageBundle(root);
    expect(b.version).toMatch(/^[0-9a-f]{12}$/);
    expect(Object.keys(b.manifest.files)).toEqual(
      expect.arrayContaining(['stage.js', 'stage.css', 'index.html']),
    );
    expect(manifestVersion(b.manifest.files)).toBe(b.version);
  });

  it('refuses a file changed after the sync', async () => {
    const { version } = await loadStageBundle(root);
    await appendFile(join(root, version, 'stage.js'), '\n// edited by hand');
    await expect(loadStageBundle(root)).rejects.toThrow(/stage\.js does not match its checksum/);
  });

  it('refuses a missing file', async () => {
    const { version } = await loadStageBundle(root);
    await rm(join(root, version, 'stage.css'));
    await expect(loadStageBundle(root)).rejects.toThrow(/missing stage\.css/);
  });

  it('refuses when CURRENT points at nothing valid', async () => {
    await writeFile(join(root, 'CURRENT'), 'not-a-version\n');
    await expect(loadStageBundle(root)).rejects.toBeInstanceOf(StageBundleError);
    await rm(join(root, 'CURRENT'));
    await expect(loadStageBundle(root)).rejects.toThrow(/sync-contracts/);
  });
});
