import type { LlmPort } from '@myvideo/domain';
import type { EntityManager } from 'typeorm';
import { describe, expect, it } from 'vitest';
import type { JobEntity } from '../db/entities/job.entity.js';
import { MemoryLlmCallStore, StructuredLlm } from '../llm/structured-llm.js';
import {
  asrMergeHandler,
  asrPlanHandler,
  type TranscribeDeps,
  transcribeHandlers,
} from './transcribe-handlers.js';
import { fixTranscriptBatches } from './transcript-fix.js';

// Validator plumbing only: deterministic stub answers, not a quality evaluation.
const segments = Array.from({ length: 41 }, (_, seq) => ({
  seq,
  words: [{ text: 'รับพิม', startMs: seq * 100, endMs: seq * 100 + 90, kind: 'word' }],
}));
function stub(calls: unknown[], text = 'รับพิมพ์'): LlmPort {
  return {
    mode: 'local-agent',
    async generateStructured(request) {
      const input = JSON.parse(request.prompt);
      calls.push(input);
      const parsed = request.schema.parse({
        lines: input.lines.map((s: { id: string }) => ({ id: s.id, text })),
      });
      if (!parsed.ok) throw new Error(parsed.error);
      return {
        value: parsed.value,
        mode: 'local-agent',
        model: 'stub',
        cached: false,
        calls: 1,
        durationMs: 0,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsdEstimate: null,
        },
      };
    },
  };
}
describe('transcript correction batches', () => {
  it('appends the fix step after merge and for a cached transcript', async () => {
    const deps = {} as TranscribeDeps;
    const job = { payload: {} } as JobEntity;
    const em = {} as EntityManager;
    const expected = [
      expect.objectContaining({ type: 'transcript.fix', queue: 'ai', payload: { transcriptId: 't' } }),
    ];
    expect(await asrMergeHandler(deps).next?.(job, { transcriptId: 't' }, em)).toEqual(expected);
    expect(await asrPlanHandler(deps).next?.(job, { transcriptId: 't', cached: true }, em)).toEqual(expected);
    const handlers = transcribeHandlers(deps);
    expect(handlers.at(-1)?.type).toBe('transcript.fix');
    expect(handlers.at(-1)?.next).toBeUndefined();
  });
  it('reuses completed batches from cache after a retry with a new merchant edit', async () => {
    let calls = 0;
    const llm = new StructuredLlm(
      {
        mode: 'local-agent',
        modelFor: () => 'stub',
        async call(request) {
          calls++;
          const input = JSON.parse(request.prompt) as { lines: { id: string }[] };
          return {
            output: { lines: input.lines.map((s) => ({ id: s.id, text: 'รับพิมพ์' })) },
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              costUsdEstimate: null,
            },
          };
        },
      },
      new MemoryLlmCallStore(),
      { maxCallsPerRun: 10 },
    );
    await expect(
      fixTranscriptBatches(
        llm,
        segments,
        new Set(),
        null,
        { merchantId: 'm' },
        new AbortController().signal,
        async () => {
          throw new Error('interrupted');
        },
      ),
    ).rejects.toThrow('interrupted');
    expect(calls).toBe(1);
    const fixes = await fixTranscriptBatches(
      llm,
      segments,
      new Set(['0:0']),
      null,
      { merchantId: 'm' },
      new AbortController().signal,
      async () => {},
    );
    expect(calls).toBe(2);
    expect(fixes).toHaveLength(40);
  });
  it('passes cancellation to an active call and stops without a second batch', async () => {
    const controller = new AbortController();
    let started = false;
    const llm = new StructuredLlm(
      {
        mode: 'local-agent',
        modelFor: () => 'stub',
        async call(request) {
          started = true;
          expect(request.signal).toBe(controller.signal);
          controller.abort(new Error('cancelled in call'));
          request.signal?.throwIfAborted();
          throw new Error('signal missing');
        },
      },
      new MemoryLlmCallStore(),
      { maxCallsPerRun: 10 },
    );
    await expect(
      fixTranscriptBatches(
        llm,
        segments,
        new Set(),
        null,
        { merchantId: 'm' },
        controller.signal,
        async () => {},
      ),
    ).rejects.toThrow('cancelled in call');
    expect(started).toBe(true);
  });
  it('limits batches, supplies boundary context and excludes merchant edits', async () => {
    const calls: unknown[] = [];
    const progress: number[] = [];
    const edits = await fixTranscriptBatches(
      stub(calls),
      segments,
      new Set(['0:0']),
      null,
      { merchantId: 'm' },
      new AbortController().signal,
      async (p: number) => {
        progress.push(p);
      },
    );
    expect(edits).toHaveLength(40);
    expect(edits.some((e) => e.seq === 0)).toBe(false);
    expect(edits[0]).toEqual({ seq: 1, wordIndex: 0, text: 'รับพิมพ์' });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ topic: '', glossary: [], lines: expect.any(Array) });
    const batches = calls as { lines: { previous: string | null; next: string | null }[] }[];
    expect(batches.map((b) => b.lines.length)).toEqual([40, 1]);
    expect(batches[0]?.lines[39]?.next).toBe('รับพิม');
    expect(batches[1]?.lines[0]?.previous).toBe('รับพิม');
    expect(progress).toEqual([40 / 41, 1]);
  });
  it('never applies a changed or invented number', async () => {
    expect(
      await fixTranscriptBatches(
        stub([], 'รับพิมพ์ 99'),
        segments.slice(0, 1),
        new Set(),
        null,
        { merchantId: 'm' },
        new AbortController().signal,
        async () => {},
      ),
    ).toEqual([]);
  });
  it('rules and failures succeed without edits; cancellation escapes', async () => {
    const llm = stub([]);
    for (const port of [
      { ...llm, mode: 'rules' as const },
      {
        ...llm,
        generateStructured: async () => {
          throw new Error('cap');
        },
      },
    ]) {
      expect(
        await fixTranscriptBatches(
          port,
          segments,
          new Set(),
          null,
          { merchantId: 'm' },
          new AbortController().signal,
          async () => {},
        ),
      ).toEqual([]);
    }
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(
      fixTranscriptBatches(
        llm,
        segments,
        new Set(),
        null,
        { merchantId: 'm' },
        controller.signal,
        async () => {},
      ),
    ).rejects.toThrow('cancelled');
  });

  it('a glossary term repairs a split brand: the term on the first word, the rest become continuations', async () => {
    // real ASR of the S01 tie-dye live: "ของ ควิก บู นะ" (brand Liquid Blue)
    const brand = [
      {
        seq: 7,
        words: ['ของ', 'ควิก', 'บู', 'นะ'].map((text, i) => ({
          text,
          startMs: i * 300,
          endMs: i * 300 + 290,
          kind: 'word',
        })),
      },
    ];
    const context = {
      topic: 'ไลฟ์ขายเสื้อมัดย้อม',
      terms: [{ term: 'Liquid Blue', kind: 'brand' as const, heardAs: ['ควิก บู'] }],
    };
    const calls: unknown[] = [];
    const fixes = await fixTranscriptBatches(
      stub(calls, 'ของ Liquid Blue นะ'),
      brand,
      new Set(),
      context,
      { merchantId: 'm' },
      new AbortController().signal,
      async () => {},
    );
    expect(fixes).toEqual([
      { seq: 7, wordIndex: 1, text: 'Liquid Blue' },
      { seq: 7, wordIndex: 2, text: '' },
    ]);
    expect(calls[0]).toMatchObject({
      topic: 'ไลฟ์ขายเสื้อมัดย้อม',
      glossary: [{ term: 'Liquid Blue', heardAs: ['ควิก บู'] }],
    });
    // the merchant already edited "บู": the whole span stays as heard
    expect(
      await fixTranscriptBatches(
        stub([], 'ของ Liquid Blue นะ'),
        brand,
        new Set(['7:2']),
        context,
        { merchantId: 'm' },
        new AbortController().signal,
        async () => {},
      ),
    ).toEqual([]);
  });
});
