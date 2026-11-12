import { LlmCallError, type LlmTier } from '@myvideo/domain';
import type { AdapterCall, AdapterResult, LlmAdapter } from './adapter.js';

/**
 * `LLM_MODE=api` with `LLM_PROVIDER=openrouter`: an OpenAI-compatible chat-completions gateway that routes to many
 * model vendors with one key. Structured output via `response_format.json_schema` (strict) and
 * `provider.require_parameters` so only endpoints that honour the schema are used. Cost comes back in `usage.cost`
 * (credits ≈ USD). Facts read from the provider's API reference, structured-outputs and usage-accounting pages
 * on 2026-11-13. Vendor names stay inside this file (AGENTS §11).
 */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_DEFAULT_MODEL = 'anthropic/claude-sonnet-5.5';

export type OpenRouterOptions = {
  apiKey: string;
  baseURL?: string;
  models?: Partial<Record<LlmTier, string>>;
  timeoutMs?: number;
  maxRetries?: number;
  /** Injected in tests (replay of recorded responses); defaults to global fetch. */
  fetch?: typeof fetch;
};

type ChatResponse = {
  error?: { code?: number; message?: string };
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null };
    error?: { code?: number; message?: string };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    cost?: number;
  };
};

/** The request body for one call (exported for tests). */
export function openRouterBody(c: AdapterCall): Record<string, unknown> {
  return {
    model: c.model,
    max_tokens: c.maxOutputTokens,
    messages: [
      ...(c.system ? [{ role: 'system', content: c.system }] : []),
      { role: 'user', content: c.prompt },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'answer', strict: true, schema: c.jsonSchema },
    },
    provider: { require_parameters: true },
  };
}

/** Turns a 200 response body into an adapter result; throws LlmCallError for anything but an answer. */
export function parseOpenRouterResponse(body: ChatResponse): AdapterResult {
  if (body.error) {
    const code = body.error.code ?? 0;
    throw new LlmCallError(`LLM API error ${code}: ${body.error.message ?? ''}`, code === 429 || code >= 500);
  }
  const choice = body.choices?.[0];
  if (!choice) throw new LlmCallError('LLM API returned no choices', true);
  if (choice.finish_reason === 'error' || choice.error) {
    throw new LlmCallError(`LLM generation failed: ${choice.error?.message ?? 'unknown'}`, true);
  }
  if (choice.finish_reason === 'length') throw new LlmCallError('answer cut off at max_tokens', false);
  if (choice.finish_reason === 'content_filter')
    throw new LlmCallError('the model declined the request (content filter)', false);
  const text = choice.message?.content ?? '';
  let output: unknown;
  try {
    output = JSON.parse(text);
  } catch {
    output = text;
  }
  const u = body.usage ?? {};
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = u.prompt_tokens_details?.cache_write_tokens ?? 0;
  return {
    output,
    usage: {
      inputTokens: Math.max(0, (u.prompt_tokens ?? 0) - cached - cacheWrite),
      outputTokens: u.completion_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: cacheWrite,
      costUsdEstimate: typeof u.cost === 'number' ? u.cost : null,
    },
  };
}

const RETRYABLE = new Set([408, 429, 500, 502, 503]);

export class OpenRouterApiAdapter implements LlmAdapter {
  readonly mode = 'api' as const;
  private readonly models: Record<LlmTier, string>;
  private readonly baseURL: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: OpenRouterOptions) {
    this.models = {
      fast: opts.models?.fast ?? OPENROUTER_DEFAULT_MODEL,
      smart: opts.models?.smart ?? OPENROUTER_DEFAULT_MODEL,
    };
    this.baseURL = (opts.baseURL ?? OPENROUTER_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.fetchFn = opts.fetch ?? fetch;
  }

  modelFor(tier: LlmTier): string {
    return this.models[tier];
  }

  async call(c: AdapterCall): Promise<AdapterResult> {
    let lastErr: LlmCallError | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      c.signal?.throwIfAborted();
      try {
        return await this.once(c);
      } catch (err) {
        if (!(err instanceof LlmCallError) || !err.retryable) throw err;
        lastErr = err;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
    throw lastErr ?? new LlmCallError('LLM API call failed', true);
  }

  private async once(c: AdapterCall): Promise<AdapterResult> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = c.signal ? AbortSignal.any([c.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          'Content-Type': 'application/json',
          'X-OpenRouter-Title': 'MyVideo',
        },
        body: JSON.stringify(openRouterBody(c)),
        signal,
      });
    } catch (err) {
      if (c.signal?.aborted) throw err;
      throw new LlmCallError(`LLM API call failed: ${(err as Error).message}`, true);
    }
    let body: ChatResponse;
    try {
      body = (await res.json()) as ChatResponse;
    } catch {
      throw new LlmCallError(`LLM API returned non-JSON (HTTP ${res.status})`, RETRYABLE.has(res.status));
    }
    if (!res.ok) {
      throw new LlmCallError(
        `LLM API error ${res.status}: ${body.error?.message ?? res.statusText}`,
        RETRYABLE.has(res.status),
      );
    }
    return parseOpenRouterResponse(body);
  }
}
