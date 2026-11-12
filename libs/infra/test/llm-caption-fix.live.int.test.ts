import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CAPTION_FIX_PROMPT_VERSION,
  type CaptionSegment,
  correctCaptions,
} from '../src/highlights/caption-fix.js';
import { ClaudeCliAdapter, type CliExec, realCliExec } from '../src/llm/local-agent-claude.js';
import { MemoryLlmCallStore, StructuredLlm } from '../src/llm/structured-llm.js';

/** Explicit opt-in only. Real user-reported ASR text; times are plumbing inputs, not audio measurements.
 * The exact garbled Liquid Blue transcription is unknown, so it is NOT fabricated here.
 * Review the saved input/output before accepting this fixture as spelling-quality evidence.
 */
describe.skipIf(process.env.LLM_LIVE !== '1')('caption spelling live recording', () => {
  it('records real responses and reversible caption words', { timeout: 300_000 }, async () => {
    const segments: CaptionSegment[] = ['สวัสดีคะ', 'สุนัก', 'รับพิม', 'ตำหนี'].map((text, i) => ({
      id: `s${i}`,
      words: [{ text, startMs: i * 1000, endMs: i * 1000 + 900 }],
    }));
    const merchantTerms = ['Liquid Blue'];
    const responses: unknown[] = [];
    const exec: CliExec = async (command, args, cwd, timeoutMs) => {
      const result = await realCliExec(command, args, cwd, timeoutMs);
      const response = JSON.parse(result.stdout) as Record<string, unknown>;
      for (const key of ['session_id', 'uuid', 'credential_expires_at']) delete response[key];
      responses.push(response);
      return result;
    };
    const store = new MemoryLlmCallStore();
    const adapter = new ClaudeCliAdapter({ exec });
    const llm = new StructuredLlm(adapter, store, { maxCallsPerRun: 2 });
    const words = await correctCaptions(llm, segments, merchantTerms, {
      merchantId: 'live-test',
      workflowRunId: 'caption-fix-live',
    });
    writeFileSync(
      new URL('../src/highlights/fixtures/caption-fix.json', import.meta.url),
      `${JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          model: adapter.modelFor('fast'),
          effort: 'medium',
          promptVersion: CAPTION_FIX_PROMPT_VERSION,
          source:
            'User-reported ASR errors; timing is test-only; exact garbled brand transcription not supplied',
          segments,
          merchantTerms,
          responses,
          words,
        },
        null,
        2,
      )}\n`,
    );
    expect(store.rows.some((r) => r.status === 'ok')).toBe(true);
    expect(words).toHaveLength(4);
    expect(words.some((w) => w.asrText !== undefined)).toBe(true);
    expect(words.map((w) => [w.startMs, w.endMs])).toEqual([
      [0, 900],
      [1000, 1900],
      [2000, 2900],
      [3000, 3900],
    ]);
    console.log(JSON.stringify(words, null, 2));
  });
});
