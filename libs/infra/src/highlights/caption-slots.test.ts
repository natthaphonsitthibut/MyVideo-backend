import type { LlmPort, LlmRequest } from '@myvideo/domain';
import { describe, expect, it } from 'vitest';
import { RulesOnlyLlm } from '../llm/structured-llm.js';
import { correctTranscriptSlots, TRANSCRIPT_SPELLING_PROMPT_VERSION } from './caption-fix.js';

const w = (text: string) => ({ text, startMs: 0, endMs: 1 });
// real ASR tokens (S01 tie-dye live): the brand "Liquid Blue" split into "ควิก บู", "พิม" for "พิมพ์"
const segments = [
  { id: '0', words: ['ตัว', 'นี้', 'ของ', 'ควิก', 'บู', 'นะ'].map(w) },
  { id: '1', words: ['รับ', 'พิม', 'ลาย', 'นี้'].map(w) },
];

function answering(tokens: string[][]) {
  const seen: LlmRequest<unknown>[] = [];
  const llm = {
    mode: 'local-agent',
    generateStructured: async (req: LlmRequest<unknown>) => {
      seen.push(req);
      return { value: { segments: tokens.map((t, i) => ({ id: String(i), tokens: t })) } };
    },
  } as unknown as LlmPort;
  return { llm, seen };
}

describe('correctTranscriptSlots (transcript pass with whole-video context)', () => {
  it('a glossary term may repair a split brand: term in the first slot, "" in the rest', async () => {
    const { llm, seen } = answering([
      ['ตัว', 'นี้', 'ของ', 'Liquid Blue', '', 'นะ'],
      ['รับ', 'พิมพ์', 'ลาย', 'นี้'],
    ]);
    const r = await correctTranscriptSlots(
      llm,
      segments,
      { topic: 'ไลฟ์ขายเสื้อมัดย้อม', terms: ['Liquid Blue'] },
      { merchantId: 'm' },
    );
    expect(r).toEqual([
      ['ตัว', 'นี้', 'ของ', 'Liquid Blue', '', 'นะ'],
      ['รับ', 'พิมพ์', 'ลาย', 'นี้'],
    ]);
    // the prompt carries the topic and the glossary; its own version
    const prompt = JSON.parse(seen[0]?.prompt ?? '{}') as { topic: string; merchantTerms: string[] };
    expect(prompt.topic).toBe('ไลฟ์ขายเสื้อมัดย้อม');
    expect(prompt.merchantTerms).toEqual(['Liquid Blue']);
    expect(seen[0]?.promptVersion).toBe(TRANSCRIPT_SPELLING_PROMPT_VERSION);
  });

  it('the same merge without the term in the glossary is refused (that segment stays as heard)', async () => {
    const { llm } = answering([
      ['ตัว', 'นี้', 'ของ', 'Liquid Blue', '', 'นะ'],
      ['รับ', 'พิมพ์', 'ลาย', 'นี้'],
    ]);
    const r = await correctTranscriptSlots(llm, segments, { topic: '', terms: [] }, { merchantId: 'm' });
    expect(r).toEqual([null, ['รับ', 'พิมพ์', 'ลาย', 'นี้']]);
  });

  it('rules mode makes no call', async () => {
    expect(
      await correctTranscriptSlots(
        new RulesOnlyLlm(),
        segments,
        { topic: '', terms: [] },
        { merchantId: 'm' },
      ),
    ).toEqual([null, null]);
  });
});
