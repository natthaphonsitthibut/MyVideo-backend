import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  assertValidKey,
  type ByteRange,
  InvalidRangeError,
  type ObjectStat,
  type ReadResult,
  StorageNotFoundError,
  type StoragePort,
  type StoredObject,
} from '@myvideo/domain';

/** Local-disk adapter for development and tests (ARCHITECTURE §8). Atomic writes via temp file + rename. */
export class LocalStorage implements StoragePort {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathOf(key: string): string {
    assertValidKey(key);
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error(`invalid storage key: ${key}`);
    return p;
  }

  async put(key: string, body: AsyncIterable<Uint8Array> | Uint8Array): Promise<StoredObject> {
    const target = this.pathOf(key);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${randomUUID()}`;
    const hash = createHash('sha256');
    let size = 0;
    const source = body instanceof Uint8Array ? Readable.from([body]) : Readable.from(body);
    try {
      await pipeline(
        source,
        async function* (chunks: AsyncIterable<Uint8Array>) {
          for await (const c of chunks) {
            hash.update(c);
            size += c.length;
            yield c;
          }
        },
        createWriteStream(tmp, { flags: 'wx' }),
      );
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    return { size, sha256: hash.digest('hex') };
  }

  async stat(key: string): Promise<ObjectStat | null> {
    const path = this.pathOf(key); // throws on an unsafe key before any I/O
    try {
      const s = await stat(path);
      return s.isFile() ? { size: s.size, modifiedAt: s.mtime } : null;
    } catch {
      return null;
    }
  }

  async read(key: string, range?: ByteRange): Promise<ReadResult> {
    const s = await this.stat(key);
    if (!s) throw new StorageNotFoundError(key);
    if (range && (range.start < 0 || range.end < range.start || range.start >= s.size)) {
      throw new InvalidRangeError(range, s.size);
    }
    const r = range ? { start: range.start, end: Math.min(range.end, s.size - 1) } : undefined;
    const body = createReadStream(this.pathOf(key), r ? { start: r.start, end: r.end } : {});
    return { body, size: s.size, length: r ? r.end - r.start + 1 : s.size, ...(r ? { range: r } : {}) };
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }

  async list(prefix: string): Promise<string[]> {
    const dir = resolve(this.root, prefix);
    if (!dir.startsWith(this.root + sep)) return [];
    const out: string[] = [];
    const walk = async (d: string): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (!e.name.includes('.tmp-')) out.push(relative(this.root, p).split(sep).join('/'));
      }
    };
    await walk(prefix.endsWith('/') ? dir : dirname(dir));
    return out.filter((k) => k.startsWith(prefix));
  }

  async localPath(key: string): Promise<{ path: string; release: () => Promise<void> }> {
    if (!(await this.stat(key))) throw new StorageNotFoundError(key);
    return { path: this.pathOf(key), release: async () => {} };
  }

  async signedUrl(): Promise<string | null> {
    return null; // local files are streamed through the authorised API
  }
}
