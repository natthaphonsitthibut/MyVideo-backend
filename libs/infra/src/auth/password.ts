import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  pw: string,
  salt: Buffer,
  len: number,
  opts: object,
) => Promise<Buffer>;
// OWASP-recommended scrypt cost (N=2^17, r=8, p=1) needs 128 MiB per hash; we use N=2^15 (32 MiB) to stay
// light on 8 GB machines and small containers. Parameters are stored in the hash so they can be raised later.
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 64 * 1024 * 1024;

/** Format: `scrypt$N$r$p$saltB64$hashB64`. */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) throw new Error('password must be at least 8 characters');
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (!n || !r || !p) return false;
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (expected.length !== KEYLEN) return false;
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM });
  return timingSafeEqual(key, expected);
}
