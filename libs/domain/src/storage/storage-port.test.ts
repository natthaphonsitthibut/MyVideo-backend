import { describe, expect, it } from 'vitest';
import { assertValidKey, storageKeys } from './storage-port.js';

const M = '01900000-0000-7000-8000-000000000001';
const S = '01900000-0000-7000-8000-000000000002';

describe('storage keys', () => {
  it('builds keys inside the merchant prefix', () => {
    expect(storageKeys.original(M, S, '.MP4')).toBe(`m/${M}/sources/${S}/original.mp4`);
    expect(storageKeys.derived(M, S, 'a1', 'proxy', 2, 'mp4')).toBe(
      `m/${M}/sources/${S}/derived/a1/proxy-v2.mp4`,
    );
    for (const k of [storageKeys.original(M, S, 'mov'), storageKeys.render(M, 'r1', 'out.mp4')]) {
      expect(k.startsWith(storageKeys.merchantPrefix(M))).toBe(true);
      expect(() => assertValidKey(k)).not.toThrow();
    }
  });
  it('never trusts the client extension', () => {
    expect(storageKeys.original(M, S, '../../etc/passwd')).toMatch(/original\.bin$/);
  });
  it('rejects traversal, absolute and odd keys', () => {
    for (const bad of ['../x', 'a/../b', '/abs', 'a//b', 'dir/', 'A/upper', 'sp ace', '', 'x\u0000y']) {
      expect(() => assertValidKey(bad), bad).toThrow(/invalid storage key/);
    }
  });
});
