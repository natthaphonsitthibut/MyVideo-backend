import { readdirSync, readFileSync } from 'node:fs';
import {
  LlmBudgetError,
  LlmCallError,
  LlmInvalidOutputError,
  type LlmRequest,
  LlmUnavailableError,
} from '@myvideo/domain';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadEnv } from '../config/env.js';
import { AnthropicApiAdapter, estimateCostUsd } from './api-anthropic.js';
import { createLlm, createLlmAdapter } from './create-llm.js';
import { ClaudeCliAdapter, type CliExec, parseClaudeCliOutput } from './local-agent-claude.js';
import { zodStructuredSchema } from './schema.js';
import { MemoryLlmCallStore, RulesOnlyLlm, StructuredLlm } from './structured-llm.js';

/** Real recorded `claude -p` stdout (see test/llm-local-agent.live.int.test.ts, which re-records them). */
const recorded = (name: string) =>
  JSON.stringify(
    (
      JSON.parse(readFileSync(new URL(`./fixtures/claude-cli-${name}.json`, import.meta.url), 'utf8')) as {
        stdout: unknown;
      }
    ).stdout,
  );
const SHIPPING_LINE = 'ค่าจะส่ง 2 ตัวแรก 50 บาท ตัวตัวไปตัวละ 10 บาทนะคะ';
const PRICE_LINE = 'ตัวนี้รับพิมรับมา 80 บาทนะ';

const LINE = z.object({ type: z.enum(['price', 'shipping', 'chatter']), quote: z.string() });
const req = (
  line: string,
  schema = zodStructuredSchema('line-class', LINE),
): LlmRequest<z.infer<typeof LINE>> => ({
  schema,
  system:
    'You classify one sentence from a Thai live-selling transcript. Quote the exact words (copied character for character) that decide the class.',
  prompt: `Sentence: ${line}`,
  promptVersion: 'test-line-class-1',
});

/** Replays recorded stdout by the sentence in the prompt; records every invocation. */
function replay(map: Record<string, string>) {
  const calls: { command: string; args: readonly string[]; cwdEntries: string[] }[] = [];
  const exec: CliExec = async (command, args, cwd) => {
    calls.push({ command, args, cwdEntries: readdirSync(cwd) });
    const prompt = args[1] ?? '';
    const key = Object.keys(map).find((k) => prompt.includes(k));
    if (!key) throw new Error(`no recording for prompt ${prompt.slice(0, 60)}`);
    return { code: 0, stdout: map[key] as string, stderrTail: '' };
  };
  return { exec, calls };
}

describe('local-agent adapter (claude CLI) on recorded real responses', () => {
  it('spawns the verified headless call: schema, no tools, no session, no settings/MCP, empty dir', async () => {
    const r = replay({ [SHIPPING_LINE]: recorded('shipping') });
    const llm = new StructuredLlm(new ClaudeCliAdapter({ exec: r.exec }), new MemoryLlmCallStore(), {
      maxCallsPerRun: 5,
    });
    const out = await llm.generateStructured(req(SHIPPING_LINE), { merchantId: 'm1' });
    expect(out.value).toEqual({ type: 'shipping', quote: 'ค่าจะส่ง 2 ตัวแรก 50 บาท ตัวตัวไปตัวละ 10 บาท' });
    expect(SHIPPING_LINE.includes(out.value.quote)).toBe(true);
    expect(out.calls).toBe(1);
    expect(out.usage.outputTokens).toBe(120);
    expect(out.usage.costUsdEstimate).toBeCloseTo(0.0109753, 7);

    const call = r.calls[0];
    expect(call?.command).toBe('claude');
    expect(call?.cwdEntries).toEqual([]);
    const args = call?.args ?? [];
    const flag = (f: string) => args[args.indexOf(f) + 1];
    expect(args[0]).toBe('-p');
    expect(flag('--model')).toBe('claude-sonnet-5-5');
    expect(flag('--effort')).toBe('medium');
    expect(flag('--output-format')).toBe('json');
    expect(flag('--tools')).toBe('');
    expect(flag('--setting-sources')).toBe('');
    expect(args).toContain('--no-session-persistence');
    expect(args).toContain('--strict-mcp-config');
    expect(JSON.parse(flag('--json-schema') ?? '')).toMatchObject({
      type: 'object',
      required: ['type', 'quote'],
      additionalProperties: false,
    });
  });

  it('a failed CLI result is a call error, not an answer', () => {
    const failed = JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '' });
    expect(() => parseClaudeCliOutput(failed)).toThrow(LlmCallError);
    expect(() => parseClaudeCliOutput('not json')).toThrow(LlmCallError);
  });
});

describe('StructuredLlm: cache, repair, budget', () => {
  it('the same request is answered from the cache with no second model call', async () => {
    const r = replay({ [SHIPPING_LINE]: recorded('shipping') });
    const store = new MemoryLlmCallStore();
    const llm = new StructuredLlm(new ClaudeCliAdapter({ exec: r.exec }), store, { maxCallsPerRun: 5 });
    const a = await llm.generateStructured(req(SHIPPING_LINE), { merchantId: 'm1' });
    const b = await llm.generateStructured(req(SHIPPING_LINE), { merchantId: 'm1' });
    expect(b).toMatchObject({ value: a.value, cached: true, calls: 0 });
    expect(r.calls).toHaveLength(1);
    // another merchant never reads merchant m1's cache
    await llm.generateStructured(req(SHIPPING_LINE), { merchantId: 'm2' });
    expect(r.calls).toHaveLength(2);
    // a new prompt version is a new cache key
    await llm.generateStructured({ ...req(SHIPPING_LINE), promptVersion: 'v2' }, { merchantId: 'm1' });
    expect(r.calls).toHaveLength(3);
  });

  it('an answer the validator rejects gets exactly one repair attempt with the error in the prompt', async () => {
    // validator demands type "price": the recorded shipping answer fails, the recorded price answer passes
    const strict = zodStructuredSchema('line-class', LINE.extend({ type: z.literal('price') }));
    let n = 0;
    const exec: CliExec = async (_c, args) => {
      n++;
      if (n === 2) expect(args[1]).toContain('rejected by the validator');
      return { code: 0, stdout: n === 1 ? recorded('shipping') : recorded('price'), stderrTail: '' };
    };
    const store = new MemoryLlmCallStore();
    const llm = new StructuredLlm(new ClaudeCliAdapter({ exec }), store, { maxCallsPerRun: 5 });
    const out = await llm.generateStructured(req(SHIPPING_LINE, strict), {
      merchantId: 'm1',
      workflowRunId: 'run1',
    });
    expect(out.calls).toBe(2);
    expect(out.value.type).toBe('price');
    expect(store.rows.map((x) => [x.attempt, x.status])).toEqual([
      [1, 'invalid'],
      [2, 'ok'],
    ]);
    expect(out.usage.outputTokens).toBe(120 + 77);

    // both attempts invalid → error, nothing cached
    const never = zodStructuredSchema('line-class', LINE.extend({ type: z.literal('chatter') }));
    const r2 = replay({ [PRICE_LINE]: recorded('price') });
    const llm2 = new StructuredLlm(new ClaudeCliAdapter({ exec: r2.exec }), new MemoryLlmCallStore(), {
      maxCallsPerRun: 5,
    });
    await expect(llm2.generateStructured(req(PRICE_LINE, never), { merchantId: 'm1' })).rejects.toThrow(
      LlmInvalidOutputError,
    );
    expect(r2.calls).toHaveLength(2);
  });

  it('the per-run call cap stops the run before the model is called', async () => {
    const r = replay({ [SHIPPING_LINE]: recorded('shipping'), [PRICE_LINE]: recorded('price') });
    const llm = new StructuredLlm(new ClaudeCliAdapter({ exec: r.exec }), new MemoryLlmCallStore(), {
      maxCallsPerRun: 1,
    });
    await llm.generateStructured(req(SHIPPING_LINE), { merchantId: 'm1', workflowRunId: 'run1' });
    await expect(
      llm.generateStructured(req(PRICE_LINE), { merchantId: 'm1', workflowRunId: 'run1' }),
    ).rejects.toBeInstanceOf(LlmBudgetError);
    expect(r.calls).toHaveLength(1);
    // a cached answer costs nothing and is still allowed
    await expect(
      llm.generateStructured(req(SHIPPING_LINE), { merchantId: 'm1', workflowRunId: 'run1' }),
    ).resolves.toMatchObject({ cached: true });
    // another run has its own budget
    await llm.generateStructured(req(PRICE_LINE), { merchantId: 'm1', workflowRunId: 'run2' });
    expect(r.calls).toHaveLength(2);
  });
});

describe('modes', () => {
  const base = {
    DATABASE_URL: 'postgresql://x@localhost/db',
    REDIS_URL: 'redis://localhost',
    SESSION_SECRET: 'xxxxxxxx',
  };

  it('rules mode has no model: callers get LlmUnavailableError and use the rule-based pass', async () => {
    const llm = createLlm(loadEnv({ ...base, LLM_MODE: 'rules' }), new MemoryLlmCallStore());
    expect(llm).toBeInstanceOf(RulesOnlyLlm);
    expect(llm.mode).toBe('rules');
    await expect(llm.generateStructured(req(PRICE_LINE), { merchantId: 'm1' })).rejects.toBeInstanceOf(
      LlmUnavailableError,
    );
  });

  it('local-agent is refused in production; api needs provider + key', () => {
    expect(() =>
      loadEnv({ ...base, NODE_ENV: 'production', SESSION_SECRET: 'real-secret', LLM_MODE: 'local-agent' }),
    ).toThrow(/local-agent/);
    expect(() => loadEnv({ ...base, LLM_MODE: 'api' })).toThrow(/LLM_PROVIDER and LLM_API_KEY/);
    expect(createLlmAdapter(loadEnv({ ...base, LLM_MODE: 'local-agent' }))?.mode).toBe('local-agent');
    expect(() =>
      createLlmAdapter(loadEnv({ ...base, LLM_MODE: 'api', LLM_PROVIDER: 'other', LLM_API_KEY: 'k' })),
    ).toThrow(/no adapter/);
  });
});

/**
 * Hosted API adapter. There is no API key yet (needs-user #6), so these responses are NOT recordings: they follow
 * the Messages API response shape from the provider docs / SDK 1.4.0 types. The live check waits for the key.
 */
describe('api adapter (documentation-shaped responses — live check pending a key)', () => {
  const body = (text: string, extra: Record<string, unknown> = {}) => ({
    id: 'msg_doc_shape',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-5',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 40,
      output_tokens: 20,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 0,
    },
    ...extra,
  });

  it('sends structured output + cached instructions, retries an overloaded API, estimates cost', async () => {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    let n = 0;
    const fetchStub = (async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      n++;
      if (n === 1) {
        return new Response(
          JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
          {
            status: 529,
            headers: { 'content-type': 'application/json', 'retry-after-ms': '1' },
          },
        );
      }
      return new Response(JSON.stringify(body('{"type":"price","quote":"80 บาท"}')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const adapter = new AnthropicApiAdapter({ apiKey: 'test-key-not-real', fetch: fetchStub, maxRetries: 2 });
    const llm = new StructuredLlm(adapter, new MemoryLlmCallStore(), { maxCallsPerRun: 5 });
    const out = await llm.generateStructured(req(PRICE_LINE), { merchantId: 'm1' });

    expect(out).toMatchObject({
      mode: 'api',
      model: 'claude-sonnet-5-5',
      value: { type: 'price', quote: '80 บาท' },
    });
    expect(sent).toHaveLength(2); // 529 overloaded → retried by the SDK
    const b = sent[1]?.body as Record<string, any>;
    expect(sent[1]?.url).toMatch(/\/v1\/messages$/);
    expect(b.model).toBe('claude-sonnet-5-5');
    expect(b.output_config).toEqual({
      effort: 'medium',
      format: { type: 'json_schema', schema: zodStructuredSchema('x', LINE).jsonSchema },
    });
    expect(b.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(b.messages).toEqual([{ role: 'user', content: `Sentence: ${PRICE_LINE}` }]);
    // 40 in × $2 + 1000 cache read × $0.10 + 20 out × $10 per million
    expect(out.usage.costUsdEstimate).toBeCloseTo((40 * 2 + 1000 * 0.1 + 20 * 10) / 1e6, 9);
  });

  it('a refusal is a non-retryable call error', async () => {
    const fetchStub = (async () =>
      new Response(JSON.stringify(body('', { stop_reason: 'refusal' })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const llm = new StructuredLlm(
      new AnthropicApiAdapter({ apiKey: 'k', fetch: fetchStub }),
      new MemoryLlmCallStore(),
      {
        maxCallsPerRun: 5,
      },
    );
    const err = await llm.generateStructured(req(PRICE_LINE), { merchantId: 'm1' }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmCallError);
    expect((err as LlmCallError).retryable).toBe(false);
  });

  it('unknown models have no cost estimate rather than a guessed one', () => {
    expect(
      estimateCostUsd('some-other-model', {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBeNull();
  });
});

describe('zodStructuredSchema', () => {
  it('drops constraints hosted structured output rejects, but the validator still enforces them', () => {
    const s = zodStructuredSchema(
      'n',
      z.object({ start: z.number().int().min(0), tags: z.array(z.string()).max(3) }),
    );
    expect(JSON.stringify(s.jsonSchema)).not.toMatch(/minimum|maximum|maxItems|\$schema/);
    expect(s.parse({ start: -1, tags: [] }).ok).toBe(false);
    expect(s.parse({ start: 2, tags: ['a'] })).toEqual({ ok: true, value: { start: 2, tags: ['a'] } });
  });
});
