import { expect, it } from 'vitest';
import { TranscriptWord } from './transcripts.js';

it('declares AI provenance separately from merchant corrections', () => {
  const word = {
    text: 'พิมพ์',
    kind: 'word',
    startMs: 0,
    endMs: 100,
    original: null,
    aiFixed: true,
    heard: 'พิม',
    mergedInto: null,
    needsReview: true,
  };
  expect(TranscriptWord.parse(word)).toEqual(word);
  expect(TranscriptWord.safeParse({ ...word, aiFixed: undefined }).success).toBe(false);
  expect(TranscriptWord.safeParse({ ...word, heard: undefined }).success).toBe(false);
});
