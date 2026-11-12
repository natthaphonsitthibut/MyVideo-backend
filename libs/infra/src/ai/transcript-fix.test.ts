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
function stub(calls: unknown[], tokens = ['รับพิมพ์']): LlmPort {
  return {
    mode: 'local-agent',
    async generateStructured(request) {
      const input = JSON.parse(request.prompt);
      calls.push(input);
      const parsed = request.schema.parse({
        segments: input.segments.map((s: { id: string }) => ({ id: s.id, tokens })),
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
          const input = JSON.parse(request.prompt) as { segments: { id: string }[] };
          return {
            output: { segments: input.segments.map((s) => ({ id: s.id, tokens: ['รับพิมพ์'] })) },
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
      fixTranscriptBatches(llm, segments, new Set(), { merchantId: 'm' }, controller.signal, async () => {}),
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
      { merchantId: 'm' },
      new AbortController().signal,
      async (p) => {
        progress.push(p);
      },
    );
    expect(edits).toHaveLength(40);
    expect(edits.some((e) => e.seq === 0)).toBe(false);
    expect(edits[0]).toEqual({ seq: 1, wordIndex: 0, text: 'รับพิมพ์' });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ merchantTerms: [], segments: expect.any(Array) });
    const batches = calls as { segments: { context: { previous: string | null; next: string | null } }[] }[];
    expect(batches.map((b) => b.segments.length)).toEqual([40, 1]);
    expect(batches[0]?.segments[39]?.context.next).toBe('รับพิม');
    expect(batches[1]?.segments[0]?.context.previous).toBe('รับพิม');
    expect(progress).toEqual([40 / 41, 1]);
  });
  it('does not apply merges or number changes', async () => {
    for (const tokens of [['รับพิมพ์', ''], ['รับพิมพ์ 99']]) {
      expect(
        await fixTranscriptBatches(
          stub([], tokens),
          segments.slice(0, 1),
          new Set(),
          { merchantId: 'm' },
          new AbortController().signal,
          async () => {},
        ),
      ).toEqual([]);
    }
    const pair = [{ seq: 0, words: [...segments[0]!.words, ...segments[1]!.words] }];
    expect(
      await fixTranscriptBatches(
        stub([], ['รับพิมพ์', '']),
        pair,
        new Set(),
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
          { merchantId: 'm' },
          new AbortController().signal,
          async () => {},
        ),
      ).toEqual([]);
    }
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(
      fixTranscriptBatches(llm, segments, new Set(), { merchantId: 'm' }, controller.signal, async () => {}),
    ).rejects.toThrow('cancelled');
  });
});
