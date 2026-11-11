import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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

export type S3StorageConfig = {
  bucket: string;
  region?: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
};

const isNotFound = (err: unknown) => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
};

/** S3-compatible adapter (production). Vendor types stay inside this file (AGENTS.md §8.8). */
export class S3Storage implements StoragePort {
  private readonly client: S3Client;

  constructor(private readonly cfg: S3StorageConfig) {
    this.client = new S3Client({
      region: cfg.region ?? 'auto',
      ...(cfg.endpoint ? { endpoint: cfg.endpoint, forcePathStyle: true } : {}),
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }

  async put(
    key: string,
    body: AsyncIterable<Uint8Array> | Uint8Array,
    opts: { contentType?: string } = {},
  ): Promise<StoredObject> {
    assertValidKey(key);
    const hash = createHash('sha256');
    let size = 0;
    const pass = new PassThrough();
    const source = body instanceof Uint8Array ? Readable.from([body]) : Readable.from(body);
    const feeding = pipeline(
      source,
      async function* (chunks: AsyncIterable<Uint8Array>) {
        for await (const c of chunks) {
          hash.update(c);
          size += c.length;
          yield c;
        }
      },
      pass,
    );
    // multipart upload completes atomically: the object appears only when every part is in
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.cfg.bucket, Key: key, Body: pass, ContentType: opts.contentType },
      queueSize: 2,
      partSize: 8 * 1024 * 1024,
    });
    await Promise.all([feeding, upload.done()]);
    return { size, sha256: hash.digest('hex') };
  }

  async stat(key: string): Promise<ObjectStat | null> {
    assertValidKey(key);
    try {
      const h = await this.client.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      return { size: Number(h.ContentLength ?? 0), modifiedAt: h.LastModified ?? new Date(0) };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async read(key: string, range?: ByteRange): Promise<ReadResult> {
    const s = await this.stat(key);
    if (!s) throw new StorageNotFoundError(key);
    if (range && (range.start < 0 || range.end < range.start || range.start >= s.size)) {
      throw new InvalidRangeError(range, s.size);
    }
    const r = range ? { start: range.start, end: Math.min(range.end, s.size - 1) } : undefined;
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        ...(r ? { Range: `bytes=${r.start}-${r.end}` } : {}),
      }),
    );
    const body = res.Body as unknown as AsyncIterable<Uint8Array>;
    return { body, size: s.size, length: r ? r.end - r.start + 1 : s.size, ...(r ? { range: r } : {}) };
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of res.Contents ?? []) if (o.Key) out.push(o.Key);
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async localPath(key: string): Promise<{ path: string; release: () => Promise<void> }> {
    const { body } = await this.read(key);
    const dir = await mkdtemp(join(tmpdir(), 'myvideo-s3-'));
    const path = join(dir, key.split('/').pop() ?? 'object');
    try {
      await pipeline(Readable.from(body), createWriteStream(path));
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
    return { path, release: () => rm(dir, { recursive: true, force: true }) };
  }

  async signedUrl(key: string, expiresInSeconds: number): Promise<string | null> {
    assertValidKey(key);
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }
}
