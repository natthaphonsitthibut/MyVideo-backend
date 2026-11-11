import type { ByteRange } from '@myvideo/domain';

/**
 * Parses a single-range `Range: bytes=…` header against a file size. Returns undefined for "no/ignored
 * range" (serve the whole file) and null for "not satisfiable" (416).
 */
export function parseRange(header: string | undefined, size: number): ByteRange | undefined | null {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined; // multi-range or junk: ignore and send the whole file (allowed by RFC 9110)
  const [, a, b] = m;
  if (a === '' && b === '') return undefined;
  if (a === '') {
    const n = Number(b);
    if (n === 0) return null;
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  if (start >= size || end < start) return null;
  return { start, end };
}
