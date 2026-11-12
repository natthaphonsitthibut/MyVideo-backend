import type { LlmPort } from '@myvideo/domain';
import { describe, expect, it } from 'vitest';
import { RulesOnlyLlm } from '../llm/structured-llm.js';
import { buildTranscriptContext, contextSample, validateContext } from './transcript-context.js';

// Real ASR tokens from our whisper output of the S01 tie-dye live (brand "Liquid Blue" heard as "ควิก บู")
const segs = [
  { seq: 0, words: ['ตัว', 'นี้', 'ของ', 'ควิก', 'บู', 'นะ'].map((text) => ({ text, startMs: 0, endMs: 1 })) },
  { seq: 1, words: ['ไซต์', 'แอล', 'ราคา', '80', 'บาท'].map((text) => ({ text, startMs: 0, endMs: 1 })) },
  { seq: 2, words: ['เสื้อ', 'มัด', 'ยอม', 'สี', 'สด'].map((text) => ({ text, startMs: 0, endMs: 1 })) },
];

describe('validateContext', () => {
  const ok = {
    topic: 'ไลฟ์ขายเสื้อมัดย้อม',
    terms: [
      { term: 'Liquid Blue', kind: 'brand', heardAs: ['ควิก บู'] },
      { term: 'มัดย้อม', kind: 'material', heardAs: ['มัด ยอม'] },
    ],
  };

  it('keeps terms whose heard variants really occur in the transcript', () => {
    expect(validateContext(ok, segs)).toEqual(ok);
  });

  it('drops a term with an invented heard variant or a number', () => {
    const r = validateContext(
      {
        topic: 'ขายเสื้อ',
        terms: [
          ...ok.terms,
          { term: 'Blue Moon', kind: 'brand', heardAs: ['บลู มูน'] },
          { term: 'ไซซ์ 42', kind: 'size', heardAs: ['ไซต์ แอล'] },
          { term: 'ลายสวย', kind: 'vibe', heardAs: ['สี สด'] },
        ],
      },
      segs,
    );
    // the kind is only a label: an unknown one becomes "other" (the term is still checked against what was heard)
    expect(r?.terms.map((t) => [t.term, t.kind])).toEqual([
      ['Liquid Blue', 'brand'],
      ['มัดย้อม', 'material'],
      ['ลายสวย', 'other'],
    ]);
  });

  it('real answer shape (S01a run): a kind written in Thai becomes "other", heard variants match without spaces', () => {
    const r = validateContext(
      {
        topic: 'ขายเสื้อยืดวินเทจมือสอง',
        terms: [
          { kind: 'แบรนด์', term: 'Liquid Blue', heardAs: ['ควิกบู'] },
          { kind: 'ลาย', term: 'มัดย้อม', heardAs: ['มัด ยอม'] },
        ],
      },
      segs,
    );
    expect(r?.terms).toEqual([
      { term: 'Liquid Blue', kind: 'other', heardAs: ['ควิกบู'] },
      { term: 'มัดย้อม', kind: 'other', heardAs: ['มัด ยอม'] },
    ]);
  });

  it('caps the glossary at 30 terms and the topic at 120 characters', () => {
    const many = Array.from({ length: 40 }, () => ({ term: 'มัดย้อม', kind: 'material', heardAs: ['มัด ยอม'] }));
    const r = validateContext({ topic: 'ก'.repeat(300), terms: many }, segs);
    expect(r?.terms).toHaveLength(30);
    expect(r?.topic.length).toBe(120);
  });
});

describe('contextSample', () => {
  it('a long transcript is sampled evenly from start, middle and end', () => {
    const long = Array.from({ length: 1000 }, (_, i) => ({
      seq: i,
      words: [{ text: `คำ${i}`, startMs: 0, endMs: 1 }],
    }));
    const text = contextSample(long, 600);
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text).toContain('คำ0');
    expect(text).toMatch(/คำ4\d\d/);
    expect(text).toContain('คำ999');
  });
});

describe('buildTranscriptContext', () => {
  it('rules mode makes no call', async () => {
    expect(await buildTranscriptContext(new RulesOnlyLlm(), segs, { merchantId: 'm' })).toBeNull();
  });

  it('a failing model call means no context (the pass continues without it)', async () => {
    const failing = {
      mode: 'local-agent',
      generateStructured: async () => {
        throw new Error('timeout');
      },
    } as unknown as LlmPort;
    expect(await buildTranscriptContext(failing, segs, { merchantId: 'm' })).toBeNull();
  });
});
