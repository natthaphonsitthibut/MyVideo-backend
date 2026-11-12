import { LlmCallError } from '@myvideo/domain';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../config/env.js';
import { OPENROUTER_DEFAULT_MODEL, OpenRouterApiAdapter } from './api-openrouter.js';
import { createLlmAdapter } from './create-llm.js';

/**
 * Gateway adapter. Responses follow the documented chat-completions shape (read 2026-11-13); they are not
 * recordings — the live check runs once the user's key is in `backend/.env`.
 */
const schema = {
  type: 'object',
  properties: { quote: { type: 'string' } },
  required: ['quote'],
  additionalProperties: false,
};
const call = {
  system: 'rules',
  prompt: 'Sentence: ลด 80 บาท',
  jsonSchema: schema,
  model: 'm/x',
  maxOutputTokens: 500,
};

const ok = (content: string, finish = 'stop') =>
  new Response(
    JSON.stringify({
      id: 'gen-doc-shape',
      choices: [{ finish_reason: finish, message: { role: 'assistant', content } }],
      usage: {
        prompt_tokens: 1040,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 1000 },
        cost: 0.00042,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

describe('gateway api adapter (documentation-shaped responses)', () => {
  it('sends strict json_schema + require_parameters, retries a 503, reports provider cost', async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    let n = 0;
    const fetchStub = (async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), init: init ?? {} });
      n++;
      if (n === 1)
        return new Response(JSON.stringify({ error: { code: 503, message: 'no provider' } }), {
          status: 503,
        });
      return ok('{"quote":"80 บาท"}');
    }) as typeof fetch;
    const a = new OpenRouterApiAdapter({ apiKey: 'test-key-not-real', fetch: fetchStub, maxRetries: 1 });
    const out = await a.call(call);

    expect(out.output).toEqual({ quote: '80 บาท' });
    expect(out.usage).toEqual({
      inputTokens: 40,
      outputTokens: 20,
      cacheReadTokens: 1000,
      cacheWriteTokens: 0,
      costUsdEstimate: 0.00042,
    });
    expect(sent).toHaveLength(2);
    expect(sent[1]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const headers = (sent[1]?.init.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key-not-real');
    const body = JSON.parse(String(sent[1]?.init.body));
    expect(body.messages).toEqual([
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'Sentence: ลด 80 บาท' },
    ]);
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'answer', strict: true, schema },
    });
    expect(body.provider).toEqual({ require_parameters: true });
    expect(body.max_tokens).toBe(500);
  });

  it('out of credits (402) is not retried', async () => {
    let n = 0;
    const fetchStub = (async () => {
      n++;
      return new Response(JSON.stringify({ error: { code: 402, message: 'insufficient credits' } }), {
        status: 402,
      });
    }) as unknown as typeof fetch;
    const err = await new OpenRouterApiAdapter({ apiKey: 'k', fetch: fetchStub, maxRetries: 2 })
      .call(call)
      .catch((e) => e);
    expect(err).toBeInstanceOf(LlmCallError);
    expect((err as LlmCallError).retryable).toBe(false);
    expect(String((err as Error).message)).toMatch(/402/);
    expect(n).toBe(1);
  });

  it('a cut-off answer and an in-body error are call errors', async () => {
    const cut = new OpenRouterApiAdapter({ apiKey: 'k', fetch: (async () => ok('', 'length')) as any });
    await expect(cut.call(call)).rejects.toThrow(/max_tokens/);
    const inBody = new OpenRouterApiAdapter({
      apiKey: 'k',
      maxRetries: 0,
      fetch: (async () =>
        new Response(JSON.stringify({ error: { code: 400, message: 'bad schema' } }), {
          status: 200,
        })) as any,
    });
    await expect(inBody.call(call)).rejects.toThrow(/bad schema/);
  });

  it('is picked by LLM_PROVIDER=openrouter with the configured models', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgresql://x@localhost/db',
      REDIS_URL: 'redis://localhost',
      SESSION_SECRET: 'xxxxxxxx',
      LLM_MODE: 'api',
      LLM_PROVIDER: 'openrouter',
      LLM_API_KEY: 'k',
      LLM_MODEL_FAST: 'google/some-flash',
    });
    const a = createLlmAdapter(env);
    expect(a).toBeInstanceOf(OpenRouterApiAdapter);
    expect(a?.modelFor('fast')).toBe('google/some-flash');
    expect(a?.modelFor('smart')).toBe(OPENROUTER_DEFAULT_MODEL);
  });
});
