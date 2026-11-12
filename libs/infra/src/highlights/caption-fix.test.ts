import { existsSync, readFileSync } from 'node:fs';
import { CaptionWord } from '@myvideo/contracts';
import type { LlmPort } from '@myvideo/domain';
import { describe, expect, it } from 'vitest';
import { ClaudeCliAdapter } from '../llm/local-agent-claude.js';
import { MemoryLlmCallStore, RulesOnlyLlm, StructuredLlm } from '../llm/structured-llm.js';
import {
  applyCaptionFix,
  CAPTION_FIX_PROMPT_VERSION,
  correctCaptions,
  selectCaptionSegments,
} from './caption-fix.js';
import { buildClipProject, clipFrames } from './clip-project.js';
import { RISKY_TERMS } from './hooks.js';

// User-reported ASR strings; times here are plumbing inputs, not measured audio alignment.
const input = ['สวัสดีคะ', 'สุนัก', 'รับพิม', 'ตำหนี'].map((text, i) => ({
  id: `s${i}`,
  words: [{ text, startMs: i * 1000, endMs: i * 1000 + 900 }],
}));
const corrected = ['สวัสดีค่ะ', 'สุนัข', 'รับพิมพ์', 'ตำหนิ'];
const answer = { segments: corrected.map((text, i) => ({ id: `s${i}`, tokens: [text] })) };

describe('caption spelling validation and timing (hand-written validator cases, not LLM responses)', () => {
  it('keeps the clip prompt version and default neighbour context unchanged', async () => {
    const observed: { prompt: string; promptVersion: string }[] = [];
    const llm: LlmPort = {
      mode: 'local-agent',
      async generateStructured(request) {
        observed.push(request);
        throw new Error('stub unavailable');
      },
    };
    expect(await correctCaptions(llm, input, [], { merchantId: 'm' })).toEqual(input.flatMap((s) => s.words));
    expect(observed).toHaveLength(1);
    expect(observed[0]?.promptVersion).toBe('caption-spelling-v3');
    const prompt = JSON.parse(observed[0]!.prompt);
    expect(prompt.merchantTerms).toEqual([]);
    expect(prompt.segments[0].context).toEqual({ previous: null, next: 'สุนัก' });
    expect(prompt.segments[1].context).toEqual({ previous: 'สวัสดีคะ', next: 'รับพิม' });
  });
  const timed = (tokens: string[]) => [
    {
      id: 's',
      words: tokens.map((text, i) => ({ text, startMs: i * 100, endMs: i * 100 + 90 })),
    },
  ];
  it.each([
    [
      ['รับ', 'พิม', 'ลับ', 'มา'],
      ['รับ', 'พิมพ์', 'กลับ', 'มา'],
    ],
    [['ไซต์'], ['ไซซ์']],
  ])('accepts reported live-selling spelling %j', (before, after) => {
    expect(
      applyCaptionFix(timed(before), { segments: [{ id: 's', tokens: after }] }, []).map((w) => w.text),
    ).toEqual(after);
  });
  // Synthetic transliteration for mapping mechanics, NOT a recorded ASR brand or LLM answer.
  const brandInput = timed(['ลิ', 'ควิด', 'บลู', 'มา']);
  it('merges an exact merchant term with the complete audio span and original text', () => {
    const words = applyCaptionFix(
      brandInput,
      { segments: [{ id: 's', tokens: ['Liquid Blue', '', '', 'มา'] }] },
      ['Liquid Blue'],
    );
    expect(words).toEqual([
      { text: 'Liquid Blue', startMs: 0, endMs: 290, origin: 'ai', asrText: 'ลิ ควิด บลู' },
      brandInput[0]!.words[3],
    ]);
    const source = { sourceId: 's', fps: { num: 100, den: 1 }, durationFrames: 40, hasAudio: true };
    const plan = { startMs: 0, endMs: 400, words, title: 'clip' };
    const project = buildClipProject({
      projectId: 'p',
      merchantId: 'm',
      source,
      plan,
      seed: 'merge',
      pages: [{ startFrame: 0, durationFrames: 40, words: clipFrames(source, plan).words, lines: [[0, 1]] }],
    });
    const caption = Object.values(project.elements).find((e) => e.type === 'caption');
    if (caption?.type !== 'caption') throw new Error('no caption');
    expect(CaptionWord.parse(caption.words[0])).toEqual({
      text: 'Liquid Blue',
      startFrame: 0,
      endFrame: 29,
      origin: 'ai',
      asrText: 'ลิ ควิด บลู',
    });
  });
  it.each([
    { tokens: ['Liquid Blue', '', '', 'มา'], terms: [] },
    { tokens: ['liquid blue', '', '', 'มา'], terms: ['Liquid Blue'] },
    { tokens: ['LiquidBlue', '', '', 'มา'], terms: ['Liquid Blue'] },
    { tokens: ['คำอื่น', '', '', 'มา'], terms: ['Liquid Blue'] },
    { tokens: ['', 'Liquid Blue', '', 'มา'], terms: ['Liquid Blue'] },
    { tokens: ['Liquid Blue', ' ', '', 'มา'], terms: ['Liquid Blue'] },
    { tokens: ['Liquid Blue 99', '', '', 'มา'], terms: ['Liquid Blue 99'] },
    { tokens: ['Liquid Blue', '', '', 'ฟรี'], terms: ['Liquid Blue'] },
    { tokens: ['Liquid Blue', '', '', 'เปลี่ยนทุกอย่าง'], terms: ['Liquid Blue'] },
  ])('rejects invalid merges or unsafe edits: %j', ({ tokens, terms }) => {
    expect(applyCaptionFix(brandInput, { segments: [{ id: 's', tokens }] }, terms)).toEqual(
      brandInput.flatMap((s) => s.words),
    );
  });
  it('sends neighbours as read-only context without adding them to target tokens', async () => {
    let request: unknown;
    const unavailable: LlmPort = {
      mode: 'local-agent',
      generateStructured: async (value) => {
        request = JSON.parse(value.prompt);
        throw new Error('inspect request only; no fabricated LLM response');
      },
    };
    await correctCaptions(unavailable, input, ['Liquid Blue'], { merchantId: 'm' });
    expect(request).toEqual({
      merchantTerms: ['Liquid Blue'],
      segments: [
        { id: 's0', tokens: ['สวัสดีคะ'], context: { previous: null, next: 'สุนัก' } },
        { id: 's1', tokens: ['สุนัก'], context: { previous: 'สวัสดีคะ', next: 'รับพิม' } },
        { id: 's2', tokens: ['รับพิม'], context: { previous: 'สุนัก', next: 'ตำหนี' } },
        { id: 's3', tokens: ['ตำหนี'], context: { previous: 'รับพิม', next: null } },
      ],
    });
  });
  it('corrects reported spelling, preserving every time and original text', () => {
    const out = applyCaptionFix(input, answer, []);
    expect(out.map((w) => w.text)).toEqual(corrected);
    expect(out[0]).toEqual({ text: 'สวัสดีค่ะ', startMs: 0, endMs: 900, origin: 'ai', asrText: 'สวัสดีคะ' });
    expect(out.map((w) => [w.startMs, w.endMs])).toEqual([
      [0, 900],
      [1000, 1900],
      [2000, 2900],
      [3000, 3900],
    ]);
    expect(input[0]?.words[0]?.text).toBe('สวัสดีคะ');
  });
  it.each([
    { segments: answer.segments.slice(1) },
    { segments: [...answer.segments, answer.segments[0]] },
    { segments: answer.segments.map((s) => ({ ...s, id: 'unknown' })) },
    { segments: [...answer.segments].reverse() },
  ])('rejects changed segment identities or count', (bad) => {
    expect(applyCaptionFix(input, bad, [])).toEqual(input.flatMap((s) => s.words));
  });
  it.each(['สวัสดีคะ 99', 'สวัสดีคะ ๙๙', 'สวัสดีคะ ฟรี', 'เปลี่ยนทุกอย่าง', '', 'สวัสดีคะ รักษา'])(
    'rejects unsafe segment %s but keeps other fixes',
    (text) => {
      const bad = structuredClone(answer);
      bad.segments[0] = { id: 's0', tokens: [text] };
      expect(applyCaptionFix(input, bad, []).map((w) => w.text)).toEqual(['สวัสดีคะ', ...corrected.slice(1)]);
    },
  );
  it('rejects token merges and does not mark unchanged words', () => {
    const bad = structuredClone(answer);
    bad.segments[0] = { id: 's0', tokens: ['สวัสดี', 'ค่ะ'] };
    expect(applyCaptionFix(input, bad, [])[0]).toEqual(input[0]?.words[0]);
  });
  it('allows exact merchant brand terms despite large spelling distance', () => {
    // Exact garbled ASR brand was not supplied: this is a validator-only substitution case.
    const original = [{ id: 's0', words: [{ text: 'สุนัก', startMs: 10, endMs: 90 }] }];
    const brand = { segments: [{ id: 's0', tokens: ['Liquid Blue'] }] };
    expect(applyCaptionFix(original, brand, ['Liquid Blue'])[0]).toMatchObject({
      text: 'Liquid Blue',
      asrText: 'สุนัก',
      startMs: 10,
      endMs: 90,
    });
    expect(applyCaptionFix(original, brand, [])[0]?.text).toBe('สุนัก');
  });
  it.each(['100%', '100 บาท', '100 เปอร์เซ็นต์'])('does not turn a plain number into %s', (text) => {
    const original = [{ id: 's', words: [{ text: '100', startMs: 0, endMs: 10 }] }];
    expect(applyCaptionFix(original, { segments: [{ id: 's', tokens: [text] }] }, [text])[0]?.text).toBe(
      '100',
    );
  });
  it('selects only words inside the clip, including partial segments', () => {
    const words = [...input[0]!.words, ...input[1]!.words].map((w) => ({ ...w, kind: 'th' }));
    const segments = [{ text: 'สวัสดีคะ สุนัก', startMs: 0, endMs: 2000, words }];
    expect(selectCaptionSegments(segments, 1, 1)).toEqual([{ id: 's0', words: [words[1]] }]);
  });
  it('handles the actual split รับ / พิม from the recorded transcript', () => {
    const segments = [
      {
        id: 's',
        words: [
          { text: 'รับ', startMs: 397431, endMs: 397704 },
          { text: 'พิม', startMs: 397704, endMs: 397976 },
        ],
      },
    ];
    expect(applyCaptionFix(segments, { segments: [{ id: 's', tokens: ['รับ', 'พิมพ์'] }] }, [])).toEqual([
      { text: 'รับ', startMs: 397431, endMs: 397704 },
      { text: 'พิมพ์', startMs: 397704, endMs: 397976, origin: 'ai', asrText: 'พิม' },
    ]);
  });
  it('falls back without LLM and on unavailable LLM', async () => {
    expect(await correctCaptions(new RulesOnlyLlm(), input, [], { merchantId: 'm' })).toEqual(
      input.flatMap((s) => s.words),
    );
    const unavailable: LlmPort = {
      mode: 'local-agent',
      generateStructured: async () => {
        throw new Error('offline');
      },
    };
    expect(await correctCaptions(unavailable, input, [], { merchantId: 'm' })).toEqual(
      input.flatMap((s) => s.words),
    );
  });
  it.each(RISKY_TERMS)('rejects added claim %s even below the edit-distance limit', (claim) => {
    const text = 'สวัสดีคะ'.repeat(8);
    const original = [{ id: 's', words: [{ text, startMs: 0, endMs: 900 }] }];
    const value = { segments: [{ id: 's', tokens: [text + claim] }] };
    expect(applyCaptionFix(original, value, [])[0]?.text).toBe(text);
  });
  it('retains a spoken price while fixing spelling', () => {
    const original = [{ id: 's', words: [{ text: 'รับพิม 100 บาท', startMs: 0, endMs: 900 }] }];
    const value = { segments: [{ id: 's', tokens: ['รับพิมพ์ 100 บาท'] }] };
    expect(applyCaptionFix(original, value, [])[0]?.text).toBe('รับพิมพ์ 100 บาท');
  });
  it('falls back when the shared per-run budget is exhausted', async () => {
    const store = new MemoryLlmCallStore();
    const llm = new StructuredLlm(
      new ClaudeCliAdapter({
        exec: async () => {
          throw new Error('budget must prevent calling the adapter');
        },
      }),
      store,
      { maxCallsPerRun: 0 },
    );
    const out = await correctCaptions(llm, input, [], { merchantId: 'm', workflowRunId: 'r' });
    expect(out).toEqual(input.flatMap((s) => s.words));
    expect(store.rows).toEqual([]);
  });
  it('stores undo metadata after layout, with page-relative timing', () => {
    const words = applyCaptionFix(input, answer, []);
    const source = { sourceId: 'source', fps: { num: 30, den: 1 }, durationFrames: 120, hasAudio: true };
    const plan = { startMs: 0, endMs: 4000, words, title: 'clip' };
    expect(clipFrames(source, plan).words[1]).toMatchObject({ startFrame: 30, endFrame: 57 });
    const project = buildClipProject({
      projectId: 'p',
      merchantId: 'm',
      source,
      plan,
      seed: 'test',
      pages: [
        {
          startFrame: 30,
          durationFrames: 27,
          words: [{ text: 'สุนัข', startFrame: 0, endFrame: 27 }],
          lines: [[0]],
        },
      ],
    });
    const caption = Object.values(project.elements).find((e) => e.type === 'caption');
    if (caption?.type !== 'caption') throw new Error('no caption');
    expect(CaptionWord.parse(caption.words[0])).toEqual({
      text: 'สุนัข',
      startFrame: 0,
      endFrame: 27,
      origin: 'ai',
      asrText: 'สุนัก',
    });
  });
});

const fixture = new URL(`./fixtures/${CAPTION_FIX_PROMPT_VERSION}.json`, import.meta.url);
it.skipIf(!existsSync(fixture))(
  `replays real caption correction (SKIP until live recorder creates fixtures/${CAPTION_FIX_PROMPT_VERSION}.json)`,
  async () => {
    const recording = JSON.parse(readFileSync(fixture, 'utf8'));
    expect(recording.promptVersion).toBe(CAPTION_FIX_PROMPT_VERSION);
    const responses = [...recording.responses];
    const store = new MemoryLlmCallStore();
    const llm = new StructuredLlm(
      new ClaudeCliAdapter({
        exec: async () => {
          const next = responses.shift();
          if (!next) throw new Error('recording exhausted');
          return { code: 0, stdout: JSON.stringify(next), stderrTail: '' };
        },
      }),
      store,
      { maxCallsPerRun: 2 },
    );
    const ctx = { merchantId: 'replay', workflowRunId: 'replay' };
    const out = await correctCaptions(llm, recording.segments, recording.merchantTerms, ctx);
    expect(store.rows.some((r) => r.status === 'ok')).toBe(true);
    expect(out).toEqual(recording.words);
    expect(out.some((w) => w.asrText !== undefined)).toBe(true);
    const calls = store.rows.length;
    expect(await correctCaptions(llm, recording.segments, recording.merchantTerms, ctx)).toEqual(out);
    expect(store.rows).toHaveLength(calls);
  },
);
