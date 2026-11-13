import { expect, it } from 'vitest';
import { musicRhythm } from './music-analysis.js';

it('reports unknown rhythm for silence rather than inventing a BPM', () => {
  expect(musicRhythm(Array(1000).fill(0))).toMatchObject({
    bpm: null,
    confidence: 0,
    firstBeatSec: null,
    beatsSec: [],
    dropsSec: [],
  });
});
it('detects a known pulse train for DSP plumbing only, not a real-song quality benchmark', () => {
  const rms = Array.from({ length: 3000 }, (_, i) => (i % 50 === 1 ? 1 : 0));
  expect(musicRhythm(rms).bpm).toBe(120);
});
