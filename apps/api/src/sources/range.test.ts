import { describe, expect, it } from 'vitest';
import { parseRange } from './range.js';

describe('parseRange', () => {
  it('handles the forms browsers send', () => {
    expect(parseRange('bytes=0-', 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange('bytes=100-199', 1000)).toEqual({ start: 100, end: 199 });
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
  });
  it('ignores absent or unsupported ranges, refuses unsatisfiable ones', () => {
    expect(parseRange(undefined, 1000)).toBeUndefined();
    expect(parseRange('bytes=0-1,5-6', 1000)).toBeUndefined();
    expect(parseRange('bytes=1000-', 1000)).toBeNull();
    expect(parseRange('bytes=-0', 1000)).toBeNull();
  });
});
