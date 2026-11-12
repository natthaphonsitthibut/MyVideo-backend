import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CAPTION_FIX_PROMPT_VERSION,
  type CaptionSegment,
  correctCaptions,
} from '../src/highlights/caption-fix.js';
import { ClaudeCliAdapter, type CliExec, realCliExec } from '../src/llm/local-agent-claude.js';
import { MemoryLlmCallStore, StructuredLlm } from '../src/llm/structured-llm.js';

/** Explicit opt-in only. Real reported ASR errors; neighbours are an assembled test sequence,
 * not a contiguous transcript excerpt. Times are plumbing inputs, not audio measurements.
 * The two brand segments are REAL whisper output (large-v3-turbo) of live-tiedye-th-vertical-b at 24 s and
 * 41 s, split by our Thai word splitter: the seller says the tie-dye brand "Liquid Blue".
 * Review the saved input/output before accepting this fixture as spelling-quality evidence.
 */
describe.skipIf(process.env.LLM_LIVE !== '1')('caption spelling live recording', () => {
  it('records real responses and reversible caption words', { timeout: 300_000 }, async () => {
    const segments: CaptionSegment[] = [
      ['สวัสดีคะ'],
      ['รับ', 'พิม', 'ลับ', 'มา', 'ให้', 'นะ', 'คะ'],
      ['ไซต์'],
      ['สุนัก'],
      ['ตำหนี'],
      ['1995', 'ริก', 'ฤิกบู', 'นะจ๊ะ'],
      ['ไป', 'ด้วย', 'ควิก', 'บู'],
    ].map((tokens, i) => ({
      id: `s${i}`,
      words: tokens.map((text, j) => ({
        text,
        startMs: i * 2000 + j * 200,
        endMs: i * 2000 + j * 200 + 190,
      })),
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
      new URL(`../src/highlights/fixtures/${CAPTION_FIX_PROMPT_VERSION}.json`, import.meta.url),
      `${JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          model: adapter.modelFor('fast'),
          effort: 'medium',
          promptVersion: CAPTION_FIX_PROMPT_VERSION,
          source:
            'Reported ASR errors in an assembled neighbour sequence, not a continuous excerpt; timing is test-only; brand segments s5/s6 are real whisper output of live-tiedye-th-vertical-b',
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
    // Save the genuine response even if acceptance fails, so failures remain reviewable.
    expect(words.map((w) => w.text)).toEqual([
      'สวัสดีค่ะ',
      'รับ',
      'พิมพ์',
      'กลับ',
      'มา',
      'ให้',
      'นะ',
      'คะ',
      'ไซซ์',
      'สุนัข',
      'ตำหนิ',
      '1995',
      'Liquid Blue',
      'นะจ๊ะ',
      'ไป',
      'ด้วย',
      'Liquid Blue',
    ]);
    // merged brand words span their first to last original slot; every other word keeps its own time
    expect(words.map((w) => [w.startMs, w.endMs])).toEqual([
      ...segments.slice(0, 5).flatMap((s) => s.words.map((w) => [w.startMs, w.endMs])),
      [10_000, 10_190],
      [10_200, 10_590],
      [10_600, 10_790],
      [12_000, 12_190],
      [12_200, 12_390],
      [12_400, 12_790],
    ]);
    console.log(JSON.stringify(words, null, 2));
  });
});
