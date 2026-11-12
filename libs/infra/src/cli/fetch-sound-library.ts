import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { type LibrarySound, SOUND_LIBRARY, SOUND_LIBRARY_COMMIT } from '@myvideo/contracts';
import { envSchema } from '../config/env.js';
import { soundLibraryFile } from '../render/sound-library.js';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function downloadBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Sound download failed: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function fetchSoundLibrary({
  dir,
  from,
  sounds = SOUND_LIBRARY,
  download = downloadBytes,
  log = console.log,
}: {
  dir: string;
  from?: string;
  sounds?: readonly LibrarySound[];
  download?: (url: string) => Promise<Uint8Array>;
  log?: (line: string) => void;
}): Promise<void> {
  await mkdir(dir, { recursive: true });
  const counts = { ok: 0, copied: 0, fetched: 0 };
  for (const sound of sounds) {
    const target = soundLibraryFile(dir, sound.id);
    const existing = await readFile(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing && hash(existing) === sound.sha256) {
      counts.ok++;
      log(`ok ${sound.id}`);
      continue;
    }
    const bytes = from
      ? await readFile(resolve(from, sound.file))
      : await download(
          `https://raw.githubusercontent.com/wyzowl/sfx-kit/${SOUND_LIBRARY_COMMIT}/${sound.file}`,
        );
    const actual = hash(bytes);
    if (actual !== sound.sha256) throw new Error(`${sound.id}: expected ${sound.sha256}, got ${actual}`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: 'wx' });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
    const action = from ? 'copied' : 'fetched';
    counts[action]++;
    log(`${action} ${sound.id}`);
  }
  log(`Sounds: ${counts.ok} ok, ${counts.copied} copied, ${counts.fetched} fetched`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { from: { type: 'string' } } });
  const dir = envSchema.shape.SOUND_LIBRARY_DIR.parse(process.env.SOUND_LIBRARY_DIR);
  await fetchSoundLibrary({ dir, from: values.from }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
