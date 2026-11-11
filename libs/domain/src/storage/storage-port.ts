/** Byte range, inclusive end (HTTP Range semantics). */
export type ByteRange = { start: number; end: number };

export type StoredObject = { size: number; sha256: string };

export type ObjectStat = { size: number; modifiedAt: Date };

export type ReadResult = {
  body: AsyncIterable<Uint8Array>;
  /** Size of the whole object. */
  size: number;
  /** Bytes in this response (= size without range). */
  length: number;
  range?: ByteRange;
};

/**
 * Object storage port (ARCHITECTURE §8, §12). Keys are server-generated (`storageKeys`), never user input.
 * Writes are atomic: readers see the old object or the complete new one, never a partial file.
 */
export interface StoragePort {
  put(
    key: string,
    body: AsyncIterable<Uint8Array> | Uint8Array,
    opts?: { contentType?: string },
  ): Promise<StoredObject>;
  read(key: string, range?: ByteRange): Promise<ReadResult>;
  stat(key: string): Promise<ObjectStat | null>;
  delete(key: string): Promise<void>;
  /** Keys under a prefix (for cleanup); order unspecified. */
  list(prefix: string): Promise<string[]>;
  /**
   * A local file path for tools that need one (ffmpeg). Local adapter: the object itself. Remote adapters:
   * a downloaded temp copy that the caller deletes via `release`.
   */
  localPath(key: string): Promise<{ path: string; release: () => Promise<void> }>;
  /** A direct download URL if the backend supports signed URLs; null → stream through the API. */
  signedUrl(key: string, expiresInSeconds: number): Promise<string | null>;
}

export class StorageNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`object not found: ${key}`);
    this.name = 'StorageNotFoundError';
  }
}

export class InvalidRangeError extends Error {
  constructor(
    readonly range: ByteRange,
    readonly size: number,
  ) {
    super(`range ${range.start}-${range.end} not satisfiable for size ${size}`);
    this.name = 'InvalidRangeError';
  }
}

const KEY_RE = /^[a-z0-9][a-z0-9/_.-]{0,511}$/;

/** Rejects anything that could escape a prefix or the storage root. */
export function assertValidKey(key: string): void {
  if (!KEY_RE.test(key) || key.includes('..') || key.includes('//') || key.endsWith('/')) {
    throw new Error(`invalid storage key: ${JSON.stringify(key)}`);
  }
}

const SAFE_EXT = /^[a-z0-9]{1,8}$/;

/** Server-generated keys (ARCHITECTURE §8): originals are immutable, derived files carry a recipe version. */
export const storageKeys = {
  original(merchantId: string, sourceId: string, ext: string): string {
    const e = ext.toLowerCase().replace(/^\./, '');
    return `m/${merchantId}/sources/${sourceId}/original.${SAFE_EXT.test(e) ? e : 'bin'}`;
  },
  derived(
    merchantId: string,
    sourceId: string,
    assetId: string,
    kind: string,
    recipe: number,
    ext: string,
  ): string {
    return `m/${merchantId}/sources/${sourceId}/derived/${assetId}/${kind}-v${recipe}.${ext}`;
  },
  render(merchantId: string, renderId: string, file: string): string {
    return `m/${merchantId}/renders/${renderId}/${file}`;
  },
  merchantPrefix(merchantId: string): string {
    return `m/${merchantId}/`;
  },
};
