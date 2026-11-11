import { describe, expect, it } from 'vitest';
import { type SpriteIndex, spriteCell } from './sprites.js';

const idx: SpriteIndex = {
  version: 1,
  intervalSec: 1,
  cols: 10,
  rows: 10,
  tileWidth: 160,
  tileHeight: 90,
  count: 245,
  sheets: 3,
  durationMs: 245_000,
};

describe('spriteCell', () => {
  it('maps seconds to sheet, column and row', () => {
    expect(spriteCell(idx, 0)).toEqual({ index: 0, sheet: 0, col: 0, row: 0, x: 0, y: 0 });
    expect(spriteCell(idx, 13.7)).toEqual({ index: 13, sheet: 0, col: 3, row: 1, x: 480, y: 90 });
    expect(spriteCell(idx, 100)).toMatchObject({ index: 100, sheet: 1, col: 0, row: 0 });
    expect(spriteCell(idx, 199.99)).toMatchObject({ index: 199, sheet: 1, col: 9, row: 9, x: 1440, y: 810 });
  });
  it('clamps to the first and last frame', () => {
    expect(spriteCell(idx, -5).index).toBe(0);
    expect(spriteCell(idx, 10_000)).toMatchObject({ index: 244, sheet: 2, col: 4, row: 4 });
  });
});
