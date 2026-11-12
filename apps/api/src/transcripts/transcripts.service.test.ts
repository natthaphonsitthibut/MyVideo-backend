import { TranscriptEditEntity, TranscriptSegmentEntity } from '@myvideo/infra';
import { expect, it } from 'vitest';
import { withEdits } from './transcripts.service.js';

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
