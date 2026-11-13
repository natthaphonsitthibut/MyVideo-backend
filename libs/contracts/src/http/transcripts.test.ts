import { expect, it } from 'vitest';
import { TranscriptWord, TranscriptWordEdit } from './transcripts.js';

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
    deleted: false,
  };
  expect(TranscriptWord.parse(word)).toEqual(word);
  expect(TranscriptWord.safeParse({ ...word, aiFixed: undefined }).success).toBe(false);
  expect(TranscriptWord.safeParse({ ...word, heard: undefined }).success).toBe(false);
  expect(TranscriptWord.safeParse({ ...word, deleted: undefined }).success).toBe(false);
});

it('accepts an empty edit as removing the word, trimmed and NFC-normalised', () => {
  expect(TranscriptWordEdit.parse({ text: '   ' })).toEqual({ text: '' });
  expect(TranscriptWordEdit.parse({ text: ' จาก ' })).toEqual({ text: 'จาก' });
  expect(TranscriptWordEdit.safeParse({ text: 'ก'.repeat(201) }).success).toBe(false);
});
