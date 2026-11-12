import { readFileSync } from 'node:fs';
import { findHighlights, type TimedSegment } from '@myvideo/domain';
import { describe, expect, it } from 'vitest';
import { ClaudeCliAdapter, type CliExec } from '../llm/local-agent-claude.js';
import { MemoryLlmCallStore, RulesOnlyLlm, StructuredLlm } from '../llm/structured-llm.js';
import { clipTranscript, hooksSchema, suggestHooks, suggestHooksRules, untracedClaims } from './hooks.js';

/** Real S01 excerpt + the real recorded local-agent answer (test/llm-hooks.live.int.test.ts). */
const excerpt = JSON.parse(
  readFileSync(
    new URL('../../../domain/src/highlights/fixtures/s01-0400-0800.json', import.meta.url),
    'utf8',
  ),
) as { segments: TimedSegment[] };
const recording = JSON.parse(
  readFileSync(new URL('./fixtures/hooks-s01-0400-0800.json', import.meta.url), 'utf8'),
) as {
  product: { name: string };
  responses: {
    structured_output: { suggestions: { kind: string; text: string; sourceQuotes: string[] }[] };
  }[];
};
const best = findHighlights({ segments: excerpt.segments }, { topN: 1 })[0];
if (!best) throw new Error('no window');
const clip = { segments: excerpt.segments, firstSegment: best.firstSegment, lastSegment: best.lastSegment };
const clipText = clipTranscript(clip);
const squash = (s: string) => s.replace(/\s+/g, '').toLowerCase();

const replay = (responses: unknown[]) => {
  const prompts: string[] = [];
  const exec: CliExec = async (_c, args) => {
    prompts.push(args[1] ?? '');
    const next = responses.shift();
    if (!next) throw new Error('no more recorded responses');
    return { code: 0, stdout: JSON.stringify(next), stderrTail: '' };
  };
  return { exec, prompts };
};

describe('suggestHooks (LLM) on a real recorded answer', () => {
  it('returns 2 hooks + 1 title marked ai, every fact traceable to quotes found in the clip', async () => {
    const r = replay(structuredClone(recording.responses));
    const llm = new StructuredLlm(new ClaudeCliAdapter({ exec: r.exec }), new MemoryLlmCallStore(), {
      maxCallsPerRun: 5,
    });
    const out = await suggestHooks(llm, clip, recording.product, { merchantId: 'm1' });
    expect(out.map((s) => s.kind).sort()).toEqual(['hook', 'hook', 'title']);
    for (const s of out) {
      expect(s.origin).toBe('ai');
      expect(s.sources.length).toBeGreaterThan(0);
      for (const q of s.sources) expect(squash(clipText)).toContain(squash(q));
      expect(untracedClaims(s.text, s.sources, recording.product)).toEqual([]);
    }
    expect(out.find((s) => s.kind === 'title')?.productFields).toContain('name');
    expect(r.prompts[0]).toContain('PRODUCT INFO:\nname: เสื้อมัดย้อมวินเทจ');
  });

  it('rejects an invented price, an invented discount and a quote the seller never said', () => {
    const schema = hooksSchema(clipText, recording.product);
    const real = structuredClone(recording.responses[0]?.structured_output);
    expect(schema.parse(real).ok).toBe(true);

    const price = structuredClone(real);
    if (price?.suggestions[1]) price.suggestions[1].text = 'ตัวนี้ 59 บาท มีทุกไซส์'; // 59 never said
    expect(schema.parse(price).ok ? '' : (schema.parse(price) as { error: string }).error).toMatch(
      /number 59/,
    );

    const promo = structuredClone(real);
    if (promo?.suggestions[0]) promo.suggestions[0].text = 'ลดราคาวันนี้ สีสดมาก';
    expect(schema.parse(promo).ok ? '' : (schema.parse(promo) as { error: string }).error).toMatch(
      /claim "ลด"/,
    );

    const quote = structuredClone(real);
    if (quote?.suggestions[0]) quote.suggestions[0].sourceQuotes = ['รับประกันของแท้ 100%'];
    expect(schema.parse(quote).ok).toBe(false);
  });

  it('a price given by the merchant may be used even if not said in the clip', () => {
    expect(untracedClaims('เสื้อมัดย้อม 199 บาท', [], { name: 'เสื้อมัดย้อม', price: '199 บาท' })).toEqual([]);
    expect(untracedClaims('เสื้อมัดย้อม 199 บาท', [], { name: 'เสื้อมัดย้อม' })).toEqual(['number 199']);
  });
});

describe('suggestHooksRules', () => {
  it('uses the seller own strongest sentence and a price said in the clip, nothing else', () => {
    const out = suggestHooksRules(clip, { name: 'เสื้อมัดย้อมวินเทจ' });
    expect(out[0]?.kind).toBe('hook');
    const segTexts = clip.segments
      .slice(clip.firstSegment, clip.lastSegment + 1)
      .map((s) => s.text.replace(/\s+/g, ' ').trim());
    expect(segTexts).toContain(out[0]?.text);
    const title = out.find((s) => s.kind === 'title');
    expect(title?.text).toMatch(/^เสื้อมัดย้อมวินเทจ \d[\d,]* บาท$/);
    for (const s of out) {
      expect(s.origin).toBe('rules');
      expect(untracedClaims(s.text, s.sources, { name: 'เสื้อมัดย้อมวินเทจ' })).toEqual([]);
    }
  });

  it('rules mode makes no model call', async () => {
    const out = await suggestHooks(new RulesOnlyLlm(), clip, {}, { merchantId: 'm1' });
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((s) => s.origin === 'rules')).toBe(true);
  });
});
