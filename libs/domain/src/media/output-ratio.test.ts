import { describe, expect, it } from 'vitest';
import { autoOutputRatio, resolveOutputRatio } from './output-ratio.js';

const v = (width: number, height: number) => ({ width, height });

describe('output ratio (same cases as the project page)', () => {
  it('majority orientation', () => {
    expect(autoOutputRatio([v(406, 720), v(720, 1280), v(1920, 1080)])).toBe('9:16');
    expect(autoOutputRatio([v(1920, 1080), v(1280, 720), v(406, 720)])).toBe('16:9');
    expect(autoOutputRatio([v(1080, 1080), v(1080, 1080), v(406, 720)])).toBe('1:1');
  });
  it('near-square is square; 4:5 is portrait; ties/empty → 9:16; unprobed ignored', () => {
    expect(autoOutputRatio([v(1000, 1040)])).toBe('1:1');
    expect(autoOutputRatio([v(576, 720)])).toBe('9:16');
    expect(autoOutputRatio([v(406, 720), v(1920, 1080)])).toBe('9:16');
    expect(autoOutputRatio([])).toBe('9:16');
    expect(autoOutputRatio([{ width: null, height: null }, v(1920, 1080)])).toBe('16:9');
  });
  it('an explicit setting wins; auto or unknown resolves from the footage', () => {
    expect(resolveOutputRatio('4:5', [v(1920, 1080)])).toBe('4:5');
    expect(resolveOutputRatio('auto', [v(1920, 1080)])).toBe('16:9');
    expect(resolveOutputRatio(undefined, [])).toBe('9:16');
  });
});
