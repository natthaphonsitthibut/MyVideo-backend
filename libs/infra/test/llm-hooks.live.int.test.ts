import { readFileSync, writeFileSync } from 'node:fs';
import { findHighlights, type TimedSegment } from '@myvideo/domain';
import { describe, expect, it } from 'vitest';
import { suggestHooks } from '../src/highlights/hooks.js';
import { ClaudeCliAdapter, type CliExec, realCliExec } from '../src/llm/local-agent-claude.js';
import { MemoryLlmCallStore, StructuredLlm } from '../src/llm/structured-llm.js';

/**
 * LIVE (LLM_LIVE=1, outside the sandbox): hook suggestions for the best rule window of the real S01 excerpt
 * 04:00–08:00 (with a merchant product name), recorded as the replay fixture for hooks.test.ts.
 */
const live = process.env.LLM_LIVE === '1';
const excerpt = JSON.parse(
  readFileSync(new URL('../../domain/src/highlights/fixtures/s01-0400-0800.json', import.meta.url), 'utf8'),
) as { segments: TimedSegment[] };

describe.skipIf(!live)('hook suggestions live (local agent)', () => {
  it('returns 3 validated suggestions', { timeout: 300_000 }, async () => {
    const recorded: unknown[] = [];
    const exec: CliExec = async (command, args, cwd, timeoutMs) => {
      const r = await realCliExec(command, args, cwd, timeoutMs);
      const out = JSON.parse(r.stdout) as Record<string, unknown>;
      for (const k of ['session_id', 'uuid', 'credential_expires_at']) delete out[k];
      recorded.push(out);
      return r;
    };
    const llm = new StructuredLlm(new ClaudeCliAdapter({ exec }), new MemoryLlmCallStore(), {
      maxCallsPerRun: 5,
    });
    const best = findHighlights({ segments: excerpt.segments }, { topN: 1 })[0];
    if (!best) throw new Error('no window');
    const out = await suggestHooks(
      llm,
      { segments: excerpt.segments, firstSegment: best.firstSegment, lastSegment: best.lastSegment },
      { name: 'เสื้อมัดย้อมวินเทจ' },
      { merchantId: 'live-test' },
    );
    writeFileSync(
      new URL('../src/highlights/fixtures/hooks-s01-0400-0800.json', import.meta.url),
      `${JSON.stringify({ recordedAt: new Date().toISOString(), model: 'claude-sonnet-5-5', effort: 'medium', product: { name: 'เสื้อมัดย้อมวินเทจ' }, responses: recorded }, null, 2)}\n`,
    );
    console.log(JSON.stringify(out, null, 1));
    expect(out).toHaveLength(3);
  });
});
