import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SOUND_LIBRARY } from '@myvideo/contracts';
import { afterEach, expect, it } from 'vitest';
import { fetchSoundLibrary } from '../src/cli/fetch-sound-library.js';
import { soundLibraryFile } from '../src/render/sound-library.js';

const dirs: string[] = [];
async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'sound-library-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const bytes = Buffer.from([1, 2, 3, 4]); // File-transfer plumbing, not audio quality data.
const sha256 = createHash('sha256').update(bytes).digest('hex');
const sound = { ...SOUND_LIBRARY[0]!, sha256 };
const noDownload = async () => {
  throw new Error('Unexpected download');
};

it('resolves only catalogue ids inside an absolute directory', () => {
  expect(soundLibraryFile('sounds', sound.id)).toBe(resolve('sounds', `${sound.id}.wav`));
  expect(() => soundLibraryFile('sounds', '../outside')).toThrow();
  expect(() => soundLibraryFile('sounds', 'unknown')).toThrow();
});

it('skips an existing verified file without downloading', async () => {
  const dir = await scratch();
  await writeFile(join(dir, `${sound.id}.wav`), bytes);
  const lines: string[] = [];
  await fetchSoundLibrary({ dir, sounds: [sound], download: noDownload, log: (line) => lines.push(line) });
  expect(await readFile(join(dir, `${sound.id}.wav`))).toEqual(bytes);
  expect(lines[0]).toContain(`ok ${sound.id}`);
});

it('copies and verifies a local kit file', async () => {
  const dir = await scratch();
  const from = await scratch();
  const file = join(from, sound.file);
  await mkdir(resolve(file, '..'), { recursive: true });
  await writeFile(file, bytes);
  await fetchSoundLibrary({ dir, from, sounds: [sound], download: noDownload, log: () => {} });
  expect(await readFile(join(dir, `${sound.id}.wav`))).toEqual(bytes);
});

it('rejects a checksum mismatch without replacing the existing file or leaving temporary files', async () => {
  const dir = await scratch();
  const previous = Buffer.from([8]);
  const bad = Buffer.from([9]);
  await writeFile(join(dir, `${sound.id}.wav`), previous);
  const result = fetchSoundLibrary({ dir, sounds: [sound], download: async () => bad, log: () => {} });
  await expect(result).rejects.toThrow(
    `${sound.id}: expected ${sha256}, got ${createHash('sha256').update(bad).digest('hex')}`,
  );
  expect(await readFile(join(dir, `${sound.id}.wav`))).toEqual(previous);
  expect(await readdir(dir)).toEqual([`${sound.id}.wav`]);
});

it('fetches verified bytes through the injected downloader', async () => {
  const dir = await scratch();
  await fetchSoundLibrary({ dir, sounds: [sound], download: async () => bytes, log: () => {} });
  expect(await readFile(join(dir, `${sound.id}.wav`))).toEqual(bytes);
});
