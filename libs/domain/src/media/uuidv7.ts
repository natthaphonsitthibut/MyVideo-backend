import { getRandomValues } from 'node:crypto';

/** RFC 9562 UUIDv7: 48-bit Unix ms timestamp + random. Same format as Postgres 18 `uuidv7()`. */
export function uuidv7(now: number = Date.now()): string {
  const b = new Uint8Array(16);
  getRandomValues(b);
  const ts = BigInt(now);
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x70; // version 7
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80; // variant 10
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
