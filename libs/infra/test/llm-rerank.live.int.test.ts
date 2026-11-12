import { readFileSync, writeFileSync } from 'node:fs';
import { findHighlights, type TimedSegment } from '@myvideo/domain';
import { describe, expect, it } from 'vitest';
import { rerankCandidates } from '../src/highlights/rerank.js';
import { ClaudeCliAdapter, type CliExec, realCliExec } from '../src/llm/local-agent-claude.js';
import { MemoryLlmCallStore, StructuredLlm } from '../src/llm/structured-llm.js';

/**
 * LIVE (LLM_LIVE=1, outside the sandbox): re-ranks the top 4 rule windows of the real S01 excerpt 04:00–08:00
 * with the local agent and records every CLI answer (in call order) as the replay fixture for rerank.test.ts.
 */
const live = process.env.LLM_LIVE === '1';
const excerpt = JSON.parse(
  readFileSync(new URL('../../domain/src/highlights/fixtures/s01-0400-0800.json', import.meta.url), 'utf8'),
) as { segments: TimedSegment[] };

describe.skipIf(!live)('re-ranking live (local agent)', () => {
  it('returns validated results for every candidate', { timeout: 600_000 }, async () => {
    const recorded: unknown[] = [];
    const exec: CliExec = async (command, args, cwd, timeoutMs) => {
      const r = await realCliExec(command, args, cwd, timeoutMs);
      const out = JSON.parse(r.stdout) as Record<string, unknown>;
      for (const k of ['session_id', 'uuid', 'credential_expires_at']) delete out[k];
      recorded.push(out);
      return r;
    };
    const llm = new StructuredLlm(new ClaudeCliAdapter({ exec }), new MemoryLlmCallStore(), {
      maxCallsPerRun: 10,
    });
    const candidates = findHighlights({ segments: excerpt.segments }, { topN: 4 });
    const r = await rerankCandidates(
      llm,
      excerpt.segments,
      candidates,
      { merchantId: 'live-test' },
      { batchSize: 4 },
    );
    writeFileSync(
      new URL('../src/highlights/fixtures/rerank-s01-0400-0800.json', import.meta.url),
      `${JSON.stringify({ recordedAt: new Date().toISOString(), model: 'claude-sonnet-5-5', effort: 'medium', responses: recorded }, null, 2)}\n`,
    );
    console.log(JSON.stringify({ calls: r.calls, usage: r.usage, clips: r.clips }, null, 1));
    expect(r.clips).toHaveLength(4);
  });
});
