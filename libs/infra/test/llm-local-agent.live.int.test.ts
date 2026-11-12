import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ClaudeCliAdapter, type CliExec, realCliExec } from '../src/llm/local-agent-claude.js';
import { zodStructuredSchema } from '../src/llm/schema.js';
import { MemoryLlmCallStore, StructuredLlm } from '../src/llm/structured-llm.js';

/**
 * LIVE: real headless `claude` call(s) on the developer's login (no key). Runs only with LLM_LIVE=1, outside the
 * sandbox. Each run re-records the replay fixtures used by the unit tests (`src/llm/fixtures/`), so every
 * replayed response is a real one. Inputs are real S01 ASR lines (CC BY 3.0).
 */
const live = process.env.LLM_LIVE === '1';
const FIXTURES = new URL('../src/llm/fixtures/', import.meta.url);

export const LINE_SCHEMA = z.object({
  type: z.enum(['price', 'shipping', 'chatter']),
  quote: z.string(),
});
export const LINE_PROMPTS = {
  shipping: 'ค่าจะส่ง 2 ตัวแรก 50 บาท ตัวตัวไปตัวละ 10 บาทนะคะ',
  price: 'ตัวนี้รับพิมรับมา 80 บาทนะ',
} as const;
export const lineRequest = (line: string) => ({
  schema: zodStructuredSchema('line-class', LINE_SCHEMA),
  system:
    'You classify one sentence from a Thai live-selling transcript. Quote the exact words (copied character for character) that decide the class.',
  prompt: `Sentence: ${line}`,
  promptVersion: 'test-line-class-1',
});

const recording =
  (name: string): CliExec =>
  async (command, args, cwd, timeoutMs) => {
    const r = await realCliExec(command, args, cwd, timeoutMs);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    for (const k of ['session_id', 'uuid', 'credential_expires_at']) delete out[k];
    writeFileSync(
      new URL(`claude-cli-${name}.json`, FIXTURES),
      `${JSON.stringify({ recordedAt: new Date().toISOString(), command, argsWithoutPrompt: args.slice(2), stdout: out }, null, 2)}\n`,
    );
    return r;
  };

describe.skipIf(!live)('local-agent (claude CLI) live', () => {
  for (const [name, line] of Object.entries(LINE_PROMPTS)) {
    it(`returns schema-valid JSON for a real Thai line (${name})`, { timeout: 240_000 }, async () => {
      const llm = new StructuredLlm(
        new ClaudeCliAdapter({ exec: recording(name) }),
        new MemoryLlmCallStore(),
        {
          maxCallsPerRun: 5,
        },
      );
      const r = await llm.generateStructured(lineRequest(line), { merchantId: 'live-test' });
      console.log(name, JSON.stringify(r));
      expect(r.mode).toBe('local-agent');
      expect(r.model).toBe('claude-sonnet-5-5');
      expect(r.calls).toBe(1);
      expect(LINE_SCHEMA.safeParse(r.value).success).toBe(true);
    });
  }
});
