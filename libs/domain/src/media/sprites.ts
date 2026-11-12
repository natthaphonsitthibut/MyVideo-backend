/** Index of a source's thumbnail sprite sheets (ARCHITECTURE §8). One tile every `intervalSec`. */
export type SpriteIndex = {
  version: 1;
  intervalSec: number;
  cols: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  /** Total tiles over all sheets. */
  count: number;
  sheets: number;
  durationMs: number;
};

export type SpriteCell = { index: number; sheet: number; col: number; row: number; x: number; y: number };

/** Which tile shows second `t` (pure; the editor uses the same math for filmstrips and scrubbing). */
export function spriteCell(idx: SpriteIndex, t: number): SpriteCell {
  const index = Math.max(0, Math.min(idx.count - 1, Math.floor(t / idx.intervalSec)));
  const perSheet = idx.cols * idx.rows;
  const sheet = Math.floor(index / perSheet);
  const within = index % perSheet;
  const col = within % idx.cols;
  const row = Math.floor(within / idx.cols);
  return { index, sheet, col, row, x: col * idx.tileWidth, y: row * idx.tileHeight };
}
