import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { InvalidRangeError, StorageNotFoundError, type StoragePort } from '@myvideo/domain';
import { describe, expect, it } from 'vitest';

async function collect(body: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of body) parts.push(Buffer.from(c));
  return Buffer.concat(parts);
}

async function* chunked(buf: Buffer, size: number): AsyncIterable<Uint8Array> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

/**
 * The behaviour every StoragePort adapter must have. Used by the local adapter test and (when S3 env vars are
 * set) the S3 adapter test.
 */
export function storageContract(
  name: string,
  make: () => StoragePort,
  opts: { sampleFile?: Buffer } = {},
): void {
  describe(`StoragePort contract: ${name}`, () => {
    const key = (s: string) => `m/contract-${randomUUID()}/${s}`;

    it('stores a streamed body and reports size and sha256', async () => {
      const s = make();
      const data = opts.sampleFile ?? randomBytes(3 * 1024 * 1024 + 17);
      const k = key('original.mp4');
      const res = await s.put(k, chunked(data, 64 * 1024));
      expect(res).toEqual({ size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
      expect((await s.stat(k))?.size).toBe(data.length);
      expect((await collect((await s.read(k)).body)).equals(data)).toBe(true);
      await s.delete(k);
    });

    it('serves byte ranges (video seeking) and clamps the end', async () => {
      const s = make();
      const data = randomBytes(10_000);
      const k = key('r.bin');
      await s.put(k, data);
      const mid = await s.read(k, { start: 1000, end: 1999 });
      expect(mid).toMatchObject({ size: 10_000, length: 1000, range: { start: 1000, end: 1999 } });
      expect((await collect(mid.body)).equals(data.subarray(1000, 2000))).toBe(true);
      const tail = await s.read(k, { start: 9_990, end: 20_000 });
      expect(tail.length).toBe(10);
      expect((await collect(tail.body)).equals(data.subarray(9_990))).toBe(true);
      await expect(s.read(k, { start: 10_000, end: 10_010 })).rejects.toBeInstanceOf(InvalidRangeError);
      await s.delete(k);
    });

    it('reports missing objects and deletes idempotently', async () => {
      const s = make();
      const k = key('none.bin');
      expect(await s.stat(k)).toBeNull();
      await expect(s.read(k)).rejects.toBeInstanceOf(StorageNotFoundError);
      await expect(s.delete(k)).resolves.toBeUndefined();
    });

    it('overwrites atomically and lists by prefix', async () => {
      const s = make();
      const base = `m/contract-${randomUUID()}/`;
      await s.put(`${base}a.bin`, Buffer.from('one'));
      await s.put(`${base}a.bin`, Buffer.from('two!'));
      await s.put(`${base}d/b.bin`, Buffer.from('x'));
      expect((await collect((await s.read(`${base}a.bin`)).body)).toString()).toBe('two!');
      expect((await s.list(base)).sort()).toEqual([`${base}a.bin`, `${base}d/b.bin`]);
      for (const k of await s.list(base)) await s.delete(k);
      expect(await s.list(base)).toEqual([]);
    });

    it('gives tools a local file path', async () => {
      const s = make();
      const k = key('tool.bin');
      await s.put(k, Buffer.from('ffmpeg input'));
      const { path, release } = await s.localPath(k);
      const { readFile } = await import('node:fs/promises');
      expect((await readFile(path)).toString()).toBe('ffmpeg input');
      await release();
      await s.delete(k);
    });

    it('rejects unsafe keys', async () => {
      const s = make();
      await expect(s.put('../escape.bin', Buffer.from('x'))).rejects.toThrow(/invalid storage key/);
      await expect(s.read('m/../../etc/passwd')).rejects.toThrow(/invalid storage key/);
    });
  });
}
