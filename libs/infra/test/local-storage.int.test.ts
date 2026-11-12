import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { footageClip } from '../../../test/footage.js';
import { LocalStorage } from '../src/storage/local-storage.js';
import { storageContract } from '../src/storage/storage-contract.js';

const root = mkdtempSync(join(tmpdir(), 'myvideo-storage-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const clip = footageClip('talkinghead-th-portrait.mp4');

storageContract('local disk', () => new LocalStorage(root), clip ? { sampleFile: await readFile(clip) } : {});
