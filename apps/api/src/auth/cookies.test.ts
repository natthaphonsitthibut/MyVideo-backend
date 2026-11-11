import { describe, expect, it } from 'vitest';
import { readCookie, sessionCookie } from './cookies.js';

describe('cookies', () => {
  it('reads a named cookie among others', () => {
    expect(readCookie('a=1; myvideo_session=abc%2B; b=2', 'myvideo_session')).toBe('abc+');
    expect(readCookie('a=1', 'myvideo_session')).toBeUndefined();
    expect(readCookie(undefined, 'x')).toBeUndefined();
    expect(readCookie('x=%E0%A4%A', 'x')).toBeUndefined();
  });
  it('builds a hardened session cookie', () => {
    expect(sessionCookie('s', 'v', { maxAgeSeconds: 60, secure: false })).toBe(
      's=v; Path=/; HttpOnly; SameSite=Lax; Max-Age=60',
    );
    expect(sessionCookie('s', '', { maxAgeSeconds: 0, secure: true })).toMatch(/Max-Age=0; Secure$/);
  });
});
