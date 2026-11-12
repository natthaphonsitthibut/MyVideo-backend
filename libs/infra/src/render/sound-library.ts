import { resolve } from 'node:path';
import { librarySound } from '@myvideo/contracts';

/** Only catalogue ids can become file names. */
export function soundLibraryFile(dir: string, libraryId: string): string {
  if (!librarySound(libraryId)) throw new Error(`Unknown library sound: ${libraryId}`);
  return resolve(dir, `${libraryId}.wav`);
}
