import { readFileSync } from 'node:fs';
import { findHighlights, type TimedSegment } from '@myvideo/domain';
import { describe, expect, it } from 'vitest';
import { ClaudeCliAdapter, type CliExec } from '../llm/local-agent-claude.js';
import { MemoryLlmCallStore, RulesOnlyLlm, StructuredLlm } from '../llm/structured-llm.js';
import { candidateBlock, flattenWords, limitByInputShare, rerankCandidates, rerankSchema } from './rerank.js';

/** Real S01 excerpt + the real recorded local-agent answer for its top-4 rule windows (llm-rerank.live.int.test). */
const excerpt = JSON.parse(
  readFileSync(
    new URL('../../../domain/src/highlights/fixtures/s01-0400-0800.json', import.meta.url),
    'utf8',
  ),
) as { segments: TimedSegment[] };
const recording = JSON.parse(
  readFileSync(new URL('./fixtures/rerank-s01-0400-0800.json', import.meta.url), 'utf8'),
) as {
  responses: { structured_output: { results: Record<string, unknown>[] } }[];
};
const segments = excerpt.segments;
const candidates = findHighlights({ segments }, { topN: 4 });
const words = flattenWords(segments);

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

describe('rerankCandidates on a real recorded answer', () => {
  it('sends only the candidate windows and maps every result to real words and times', async () => {
    const r = replay(structuredClone(recording.responses));
    const llm = new StructuredLlm(new ClaudeCliAdapter({ exec: r.exec }), new MemoryLlmCallStore(), {
      maxCallsPerRun: 5,
    });
    const out = await rerankCandidates(llm, segments, candidates, { merchantId: 'm1' }, { batchSize: 4 });

    expect(out.calls).toBe(1);
    expect(out.clips).toHaveLength(4);
    expect(out.inputChars).toBeLessThan(out.transcriptChars);
    for (const c of out.clips) {
      expect(c.origin).toBe('llm');
      expect(c.startMs).toBe(words[c.startWord]?.startMs);
      expect(c.endMs).toBe(words[c.endWord]?.endMs);
      const span = words
        .slice(c.startWord, c.endWord + 1)
        .map((w) => w.text)
        .join('')
        .replace(/\s+/g, '');
      expect(span).toContain((c.quote ?? '').replace(/\s+/g, ''));
    }
    // ranked by model score: the ordering/shipping explanation (05:00) first
    expect(out.clips[0]).toMatchObject({ type: 'faq', score: 72 });
    expect(out.clips.map((c) => c.score)).toEqual([72, 60, 58, 55]);
    // the prompt carries word indexes the validator can check
    expect(r.prompts[0]).toContain(`words="${candidates[0]?.firstWord}-${candidates[0]?.lastWord}"`);
  });

  it('rejects an answer that quotes words the seller did not say, or leaves the window', () => {
    const batch = candidates.map((c, i) => ({ id: `c${i + 1}`, c }));
    const schema = rerankSchema(batch, words);
    const real = structuredClone(recording.responses[0]?.structured_output) as {
      results: Record<string, unknown>[];
    };
    expect(schema.parse(real).ok).toBe(true);

    const invented = structuredClone(real);
    (invented.results[0] as Record<string, unknown>).quote = 'ลดราคา 50% วันนี้เท่านั้น'; // never said
    const a = schema.parse(invented);
    expect(a.ok).toBe(false);
    expect(a.ok ? '' : a.error).toMatch(/not found verbatim/);

    const outside = structuredClone(real);
    (outside.results[1] as Record<string, unknown>).endWord = (candidates[1]?.lastWord ?? 0) + 50;
    expect(schema.parse(outside).ok).toBe(false);

    const missing = { results: real.results.slice(1) };
    const m = schema.parse(missing);
    expect(m.ok ? '' : m.error).toMatch(/missing/);
  });

  it('an invalid answer is repaired once with the validator message in the prompt', async () => {
    const bad = structuredClone(recording.responses[0]) as {
      structured_output: { results: Record<string, unknown>[] };
    };
    (bad.structured_output.results[0] as Record<string, unknown>).quote = 'ลดราคา 50% วันนี้เท่านั้น';
    const r = replay([bad, structuredClone(recording.responses[0])]);
    const llm = new StructuredLlm(new ClaudeCliAdapter({ exec: r.exec }), new MemoryLlmCallStore(), {
      maxCallsPerRun: 5,
    });
    const out = await rerankCandidates(llm, segments, candidates, { merchantId: 'm1' }, { batchSize: 4 });
    expect(out.calls).toBe(2);
    expect(r.prompts[1]).toContain('not found verbatim');
  });

  it('limitByInputShare keeps the model input within 25 % of the transcript', () => {
    const all = findHighlights({ segments }, { topN: 20 });
    const chosen = limitByInputShare(all, words);
    const total = words.reduce((n, w) => n + w.text.length, 0);
    const used = chosen.reduce(
      (n, c) => n + words.slice(c.firstWord, c.lastWord + 1).reduce((m, w) => m + w.text.length, 0),
      0,
    );
    expect(chosen.length).toBeGreaterThan(0);
    expect(chosen.length).toBeLessThan(all.length);
    expect(used / total).toBeLessThanOrEqual(0.25);
    expect(chosen).toEqual(all.slice(0, chosen.length)); // a prefix: best rule windows first
  });

  it('rules mode makes no call and keeps the rule order', async () => {
    const out = await rerankCandidates(new RulesOnlyLlm(), segments, candidates, { merchantId: 'm1' });
    expect(out.calls).toBe(0);
    expect(out.clips.map((c) => c.rulesScore)).toEqual(candidates.map((c) => c.score));
    expect(out.clips.every((c) => c.origin === 'rules' && c.quote === null)).toBe(true);
  });

  it('prompt lines index words so that line index + position = global word index', () => {
    const c = candidates[0];
    if (!c) throw new Error('no candidate');
    const block = candidateBlock('c1', c, segments);
    for (const line of block.split('\n').filter((l) => l.startsWith('['))) {
      const m = /^\[(\d+)\] (.*)$/.exec(line);
      const start = Number(m?.[1]);
      const lineWords = (m?.[2] ?? '').split(' ');
      expect(lineWords[0]).toBe(words[start]?.text.trim());
      expect(lineWords.at(-1)).toBe(words[start + lineWords.length - 1]?.text.trim());
    }
  });
});
