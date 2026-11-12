import { TranscriptEditEntity, TranscriptSegmentEntity } from '@myvideo/infra';
import { expect, it } from 'vitest';
import { aiSpanAt, withEdits } from './transcripts.service.js';

it('exposes AI and user corrections independently and restores heard text with no edit', () => {
  const segment = Object.assign(new TranscriptSegmentEntity(), {
    seq: 0,
    startMs: 0,
    endMs: 100,
    text: 'พิม',
    words: [{ text: 'พิม', kind: 'word', startMs: 0, endMs: 100 }],
  });
  const edit: TranscriptEditEntity = Object.assign(new TranscriptEditEntity(), {
    origin: 'ai' as const,
    text: 'พิมพ์',
  });
  expect(withEdits(segment, new Map([['0:0', edit]])).words[0]).toMatchObject({
    text: 'พิมพ์',
    original: null,
    aiFixed: true,
    heard: 'พิม',
  });
  edit.origin = 'user';
  expect(withEdits(segment, new Map([['0:0', edit]])).words[0]).toMatchObject({
    text: 'พิมพ์',
    original: 'พิม',
    aiFixed: false,
    heard: 'พิม',
  });
  expect(withEdits(segment, new Map()).words[0]).toMatchObject({
    text: 'พิม',
    original: null,
    aiFixed: false,
    heard: null,
  });
});

// real ASR of the S01 tie-dye live: the brand Liquid Blue heard as "ควิก บู"
const brand = Object.assign(new TranscriptSegmentEntity(), {
  seq: 3,
  startMs: 0,
  endMs: 1200,
  text: 'ของควิกบูนะ',
  words: ['ของ', 'ควิก', 'บู', 'นะ'].map((text, i) => ({
    text,
    kind: 'word',
    startMs: i * 300,
    endMs: i * 300 + 300,
  })),
});
const ai = (text: string) =>
  Object.assign(new TranscriptEditEntity(), { origin: 'ai' as const, text, reviewedAt: null as Date | null });
const merged = new Map([
  ['3:1', ai('Liquid Blue')],
  ['3:2', ai('')],
]);

it('a merged name: the head shows the name with the whole heard span, the continuation points at it', () => {
  const words = withEdits(brand, merged).words;
  expect(words[1]).toMatchObject({ text: 'Liquid Blue', aiFixed: true, heard: 'ควิก บู', mergedInto: null });
  expect(words[2]).toMatchObject({ text: '', aiFixed: true, mergedInto: 1 });
  expect(words[3]).toMatchObject({ text: 'นะ', mergedInto: null });
  expect(withEdits(brand, merged).text).toBe('ของLiquid Blueนะ');
});

it('finds the merged span from the head or from a continuation; plain words have none', () => {
  expect(aiSpanAt(merged, 3, 1, 4)).toEqual([1, 2]);
  expect(aiSpanAt(merged, 3, 2, 4)).toEqual([1, 2]);
  expect(aiSpanAt(merged, 3, 0, 4)).toBeNull();
  expect(aiSpanAt(new Map([['3:1', ai('ไซซ์')]]), 3, 1, 4)).toBeNull();
});

it('an unchecked AI correction needs review; checked ones and continuations do not', () => {
  const unchecked = withEdits(brand, merged).words;
  expect(unchecked[1]?.needsReview).toBe(true);
  expect(unchecked[2]?.needsReview).toBe(false);
  const checked = new Map([
    ['3:1', Object.assign(ai('Liquid Blue'), { reviewedAt: new Date() })],
    ['3:2', Object.assign(ai(''), { reviewedAt: new Date() })],
  ]);
  expect(withEdits(brand, checked).words[1]?.needsReview).toBe(false);
});
