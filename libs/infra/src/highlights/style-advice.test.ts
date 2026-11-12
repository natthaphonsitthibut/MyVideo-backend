import { readFileSync } from 'node:fs';
import { STYLE_PACKS } from '@myvideo/contracts';
import type { LlmPort } from '@myvideo/domain';
import { describe, expect, it } from 'vitest';
import { RulesOnlyLlm } from '../llm/structured-llm.js';
import { adviseStyles, adviseStylesRules, type VideoFeatures } from './style-advice.js';

// S01a (10 min of a Thai tie-dye live sale): measured from its transcript/VAD on 2026-11-12 (shape only here)
const busySeller: VideoFeatures = {
  durationMin: 10,
  wordsPerSec: 3.1,
  pricesPerMin: 2.4,
  ctaPerMin: 1.1,
  pausesPerMin: 3,
  productTerms: ['Liquid Blue'],
};
const calmReview: VideoFeatures = {
  durationMin: 2,
  wordsPerSec: 1.6,
  pricesPerMin: 0.2,
  ctaPerMin: 0,
  pausesPerMin: 12,
  productTerms: [],
};

describe('adviseStylesRules', () => {
  it('ranks every style once; a fast seller who talks prices gets the selling styles first', () => {
    const a = adviseStylesRules(busySeller);
    expect(a.map((x) => x.styleId).sort()).toEqual(STYLE_PACKS.map((p) => p.id).sort());
    expect(['sale-fast', 'fun']).toContain(a[0]?.styleId);
    expect(a.every((x) => x.reason.length > 0)).toBe(true);
  });

  it('a calm explainer with long pauses gets the storytelling / calm styles first', () => {
    expect(['friendly', 'premium']).toContain(adviseStylesRules(calmReview)[0]?.styleId);
  });
});

describe('adviseStyles (model)', () => {
  const answer = (items: unknown) =>
    ({
      mode: 'local-agent',
      generateStructured: async () => ({ value: { items }, model: 'm', cached: false }),
    }) as unknown as LlmPort;

  it('rules mode makes no call', async () => {
    const r = await adviseStyles(new RulesOnlyLlm(), busySeller, 'ราคา 80 บาท', { merchantId: 'm' });
    expect(r.origin).toBe('rules');
  });

  it('keeps a valid ranking and fills styles the model left out', async () => {
    const r = await adviseStyles(
      answer([
        { styleId: 'fun', reason: 'คนขายพูดเร็วและพลังเยอะ' },
        { styleId: 'sale-fast', reason: 'พูดราคาบ่อย' },
      ]),
      busySeller,
      'ราคา 80 บาท',
      { merchantId: 'm' },
    );
    expect(r.origin).toBe('ai');
    expect(r.items.slice(0, 2).map((x) => x.styleId)).toEqual(['fun', 'sale-fast']);
    expect(r.items).toHaveLength(STYLE_PACKS.length);
  });

  it('accepts a real recorded answer (S01a, local-agent, 2026-11-12) whose numbers come from the features', async () => {
    const rec = JSON.parse(
      readFileSync(new URL('./fixtures/style-advice-s01a.recorded.json', import.meta.url), 'utf8'),
    ) as { output: { items: { styleId: string; reason: string }[] } };
    // the run's measured pace and price rate (the reasons quote them); prices from the clips' own words
    const s01a = { ...busySeller, wordsPerSec: 3.1, pricesPerMin: 4.7 };
    const r = await adviseStyles(answer(rec.output.items), s01a, 'ลายแตงโม สีเขียว 100 บาท … ราคา 80 บาท', {
      merchantId: 'm',
    });
    expect(r.origin).toBe('ai');
    expect(r.items[0]?.styleId).toBe('sale-fast');
    expect(r.items.map((x) => x.styleId).at(-1)).toBe('premium');
  });

  it('an unknown style or a reason with a number the video never had falls back to rules', async () => {
    const bad = await adviseStyles(
      answer([{ styleId: 'cinematic', reason: 'ดูหรู' }]),
      busySeller,
      'ราคา 80 บาท',
      { merchantId: 'm' },
    );
    expect(bad.origin).toBe('rules');
    const invented = await adviseStyles(
      answer([{ styleId: 'sale-fast', reason: 'ยอดขายเพิ่ม 300%' }]),
      busySeller,
      'ราคา 80 บาท',
      { merchantId: 'm' },
    );
    expect(invented.origin).toBe('rules');
  });
});
