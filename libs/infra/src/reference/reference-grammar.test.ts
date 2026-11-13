import { expect, it } from 'vitest';
import { grammarPack, measureGrammar } from './reference-grammar.js';

it('transfers measured rhythm and placement as editable grammar, excluding reference assets and content', () => {
  const grammar = measureGrammar(
    12000,
    [0, 1000, 3000, 6000, 12000],
    ['#123456'],
    [
      { atMs: 500, y: 0.72, height: 0.08 },
      { atMs: 1000, y: 0.73, height: 0.08 },
    ],
    { bpm: 120, confidence: 0.8, firstBeatSec: 0.5, beatsSec: [0.5], dropsSec: [] },
  );
  expect(grammar.medianShotMs).toBe(2500);
  expect(grammar.captionBand).toBeCloseTo(0.725);
  const frozen = grammarPack('00000000-0000-7000-8000-000000000001', 'Reference', grammar);
  expect(frozen.pack.id).toBe('ref-00000000-0000-7000-8000-000000000001');
  expect(frozen.pack.sfx).toBeNull();
  expect(frozen.pack.graphics.cta).toBeNull();
  expect(JSON.stringify(frozen)).not.toMatch(/sourceId|musicId|storageKey|sourceQuotes|logo/);
  expect(frozen.pack.cuts.maxShotMs).toBe(2500);
});
