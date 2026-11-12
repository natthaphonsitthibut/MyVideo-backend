import { type LlmCallContext, type LlmPort, scoreWindows, type TimedSegment } from '@myvideo/domain';
import { z } from 'zod';
import { zodStructuredSchema } from '../llm/schema.js';

/**
 * Hook and title suggestions for a clip (E07-F06). Nothing is invented: rules mode reuses the seller's own strongest
 * sentence and fills templates only with merchant-provided product info and prices said in the clip; LLM mode must
 * cite transcript quotes, and a validator rejects any number or risky claim (discount, medical, guarantee,
 * superlative) that is not in the cited quotes or the product info. AI-written text is marked `origin: 'ai'`.
 */
export const HOOKS_PROMPT_VERSION = 'hooks-v2';

export type ProductInfo = { name?: string; price?: string; facts?: string[] };
export type HookKind = 'hook' | 'title';
export type HookSuggestion = {
  kind: HookKind;
  text: string;
  origin: 'rules' | 'ai';
  /** Transcript phrases (verbatim, inside the clip) that back the facts in `text`. */
  sources: string[];
  /** Product-info fields used. */
  productFields: string[];
};

export type ClipText = { segments: readonly TimedSegment[]; firstSegment: number; lastSegment: number };

const squash = (s: string) => s.replace(/\s+/g, '').toLowerCase();
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Terms that make a claim; allowed only when the seller said them (cited) or the merchant gave them. */
export const RISKY_TERMS = [
  'ลด',
  'โปร',
  'ฟรี',
  'แถม',
  'ถูกที่สุด',
  'ดีที่สุด',
  'อันดับ1',
  'รับประกัน',
  'การันตี',
  'ของแท้',
  'แท้100',
  'รักษา',
  'หายขาด',
  'ป้องกัน',
  'ผอม',
  'ลดน้ำหนัก',
  'ขาว',
  'ไม่มีผลข้างเคียง',
  'ปลอดภัย100',
];

const numbersIn = (s: string) => (s.replace(/,/g, '').match(/\d+(?:\.\d+)?/g) ?? []).map(Number);

/** Every number and risky term in `text` must appear in the cited quotes or the product info. */
export function untracedClaims(text: string, quotes: readonly string[], product: ProductInfo): string[] {
  const support = [...quotes, product.name ?? '', product.price ?? '', ...(product.facts ?? [])].join(' ');
  const supportNums = new Set(numbersIn(support));
  const problems: string[] = [];
  for (const n of numbersIn(text)) if (!supportNums.has(n)) problems.push(`number ${n}`);
  const t = squash(text);
  const s = squash(support);
  for (const term of RISKY_TERMS) if (t.includes(term) && !s.includes(term)) problems.push(`claim "${term}"`);
  return problems;
}

function clipSegments(c: ClipText): TimedSegment[] {
  return c.segments.slice(c.firstSegment, c.lastSegment + 1) as TimedSegment[];
}

/** Rules mode: the seller's strongest sentence as the hook + product templates. */
export function suggestHooksRules(clip: ClipText, product: ProductInfo = {}): HookSuggestion[] {
  const segs = clipSegments(clip);
  // one window per segment → the per-sentence rule score (F01 signals)
  const scored = scoreWindows({ segments: segs }, { windowMs: 1, maxWindowMs: Number.MAX_SAFE_INTEGER });
  const ranked = scored
    .map((w, i) => ({ i, score: w.score, text: clean((segs[i] as TimedSegment).text) }))
    .filter((x) => x.text.length >= 6)
    .sort((a, b) => b.score - a.score || a.i - b.i);
  const out: HookSuggestion[] = [];
  const best = ranked[0];
  if (best)
    out.push({ kind: 'hook', text: best.text, origin: 'rules', sources: [best.text], productFields: [] });
  // a price the seller said in this clip (first price signal)
  const priceSignal = scored.flatMap((w) => w.signals).find((s) => s.kind === 'price' && /\d/.test(s.term));
  const price = priceSignal?.term;
  if (product.name && price) {
    out.push({
      kind: 'title',
      text: `${product.name} ${price}`,
      origin: 'rules',
      sources: [price],
      productFields: ['name'],
    });
  } else if (product.name && product.price) {
    out.push({
      kind: 'title',
      text: `${product.name} ${product.price}`,
      origin: 'rules',
      sources: [],
      productFields: ['name', 'price'],
    });
  } else if (product.name) {
    out.push({ kind: 'title', text: product.name, origin: 'rules', sources: [], productFields: ['name'] });
  } else if (price) {
    out.push({ kind: 'title', text: `ตัวนี้ ${price}`, origin: 'rules', sources: [price], productFields: [] });
  }
  const second = ranked[1];
  if (second && out.length < 3) {
    out.push({ kind: 'hook', text: second.text, origin: 'rules', sources: [second.text], productFields: [] });
  }
  return out;
}

export const HOOKS_SYSTEM = [
  'You write short Thai on-screen text for a vertical selling clip cut from a live-selling video.',
  'The transcript is automatic speech recognition and may contain recognition errors.',
  'Use ONLY facts said in the clip transcript or given in PRODUCT INFO. Never add a price, number, discount,',
  'free gift, medical or health claim, guarantee, authenticity claim or superlative that is not said there.',
  'Return exactly 3 suggestions: 2 hooks (natural spoken Thai, at most 50 characters, makes a viewer stop',
  'scrolling in the first second) and 1 title (at most 60 characters, says what the product is).',
  'A hook carries ONE idea and reads in about one second (about 8 words or fewer). Good hook shapes, filled only',
  'with real content from the transcript or PRODUCT INFO: the price the seller says ("only [price]"), the result',
  'before the method, a problem the buyer has as a question, a number of items or reasons, or the strongest',
  'line the seller actually says (meaning unchanged). The two hooks must use DIFFERENT shapes.',
  "Never a greeting, the shop name alone, a question about the viewer's day, emoji or hashtags.",
  'For each suggestion give sourceQuotes: 1-3 phrases copied character for character from the transcript that',
  'support every fact in the text (copy the transcript as written, including its spelling).',
].join('\n');

const SUGGESTION = z.object({
  kind: z.enum(['hook', 'title']),
  text: z.string().min(2).max(80),
  sourceQuotes: z.array(z.string()).min(1).max(3),
});

export function hooksSchema(clipText: string, product: ProductInfo) {
  const hay = squash(clipText);
  const schema = z.object({ suggestions: z.array(SUGGESTION).min(3).max(3) }).superRefine((v, ctx) => {
    for (const [i, s] of v.suggestions.entries()) {
      for (const q of s.sourceQuotes) {
        if (squash(q).length === 0 || !hay.includes(squash(q))) {
          ctx.addIssue({
            code: 'custom',
            path: ['suggestions', i, 'sourceQuotes'],
            message: `quote "${q}" is not in the clip transcript`,
          });
        }
      }
      const problems = untracedClaims(s.text, s.sourceQuotes, product);
      if (problems.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['suggestions', i, 'text'],
          message: `"${s.text}" has facts not found in its quotes or the product info: ${problems.join(', ')}`,
        });
      }
    }
    if (v.suggestions.filter((s) => s.kind === 'hook').length !== 2) {
      ctx.addIssue({ code: 'custom', path: ['suggestions'], message: 'need exactly 2 hooks and 1 title' });
    }
  });
  return zodStructuredSchema('hook-suggestions', schema);
}

export function hooksPrompt(clipText: string, product: ProductInfo): string {
  const info = [
    product.name ? `name: ${product.name}` : null,
    product.price ? `price: ${product.price}` : null,
    ...(product.facts ?? []).map((f) => `fact: ${f}`),
  ].filter(Boolean);
  return `PRODUCT INFO:\n${info.length > 0 ? info.join('\n') : '(none given)'}\n\nCLIP TRANSCRIPT:\n${clipText}`;
}

export function clipTranscript(clip: ClipText): string {
  return clipSegments(clip)
    .map((s) => clean(s.text))
    .filter((t) => t.length > 0)
    .join('\n');
}

/** LLM modes: 3 validated suggestions; rules mode falls back to `suggestHooksRules`. */
export async function suggestHooks(
  llm: LlmPort,
  clip: ClipText,
  product: ProductInfo,
  ctx: LlmCallContext,
): Promise<HookSuggestion[]> {
  if (llm.mode === 'rules') return suggestHooksRules(clip, product);
  const text = clipTranscript(clip);
  const r = await llm.generateStructured(
    {
      schema: hooksSchema(text, product),
      system: HOOKS_SYSTEM,
      prompt: hooksPrompt(text, product),
      promptVersion: HOOKS_PROMPT_VERSION,
      tier: 'fast',
      maxOutputTokens: 1500,
    },
    ctx,
  );
  const value = r.value as { suggestions: { kind: HookKind; text: string; sourceQuotes: string[] }[] };
  const fields = (t: string) =>
    [
      product.name && squash(t).includes(squash(product.name)) ? 'name' : null,
      product.price && numbersIn(t).some((n) => numbersIn(product.price ?? '').includes(n)) ? 'price' : null,
    ].filter((x): x is string => x !== null);
  return value.suggestions.map((s) => ({
    kind: s.kind,
    text: clean(s.text),
    origin: 'ai',
    sources: s.sourceQuotes,
    productFields: fields(s.text),
  }));
}
