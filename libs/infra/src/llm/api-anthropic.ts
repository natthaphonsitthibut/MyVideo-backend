import Anthropic from '@anthropic-ai/sdk';
import { LlmCallError, type LlmTier, type LlmUsage } from '@myvideo/domain';
import type { AdapterCall, AdapterResult, LlmAdapter } from './adapter.js';

/**
 * `LLM_MODE=api` with `LLM_PROVIDER=anthropic` (production). Official SDK, Messages API with structured output
 * (`output_config.format` = JSON schema), the stable instructions marked for prompt caching, effort from config,
 * SDK retries on 408/409/429/5xx (overload). Vendor names and types stay inside this file (AGENTS §11).
 * Facts from the `claude-api` skill (models/prices cached 2026-11-03) and the installed SDK 1.4.0 types.
 */
export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5-5';

/** USD per million tokens (list price, first-party API). Cache writes (5 min) cost 1.25× input. */
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
};

export function estimateCostUsd(model: string, u: Omit<LlmUsage, 'costUsdEstimate'>): number | null {
  const p = PRICES[model];
  if (!p) return null;
  const usd =
    (u.inputTokens * p.input +
      u.cacheWriteTokens * p.input * 1.25 +
      u.cacheReadTokens * p.cacheRead +
      u.outputTokens * p.output) /
    1_000_000;
  return Math.round(usd * 1e6) / 1e6;
}

export type AnthropicApiOptions = {
  apiKey: string;
  baseURL?: string;
  models?: Partial<Record<LlmTier, string>>;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  timeoutMs?: number;
  maxRetries?: number;
  /** Injected in tests (replay); defaults to global fetch. */
  fetch?: typeof fetch;
};

export class AnthropicApiAdapter implements LlmAdapter {
  readonly mode = 'api' as const;
  private readonly client: Anthropic;
  private readonly models: Record<LlmTier, string>;
  private readonly effort: NonNullable<AnthropicApiOptions['effort']>;

  constructor(opts: AnthropicApiOptions) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      timeout: opts.timeoutMs ?? 120_000,
      maxRetries: opts.maxRetries ?? 3,
      fetch: opts.fetch,
    });
    this.models = {
      fast: opts.models?.fast ?? ANTHROPIC_DEFAULT_MODEL,
      smart: opts.models?.smart ?? ANTHROPIC_DEFAULT_MODEL,
    };
    this.effort = opts.effort ?? 'medium';
  }

  modelFor(tier: LlmTier): string {
    return this.models[tier];
  }

  async call(c: AdapterCall): Promise<AdapterResult> {
    let msg: Anthropic.Message;
    try {
      msg = await this.client.messages.create(
        {
          model: c.model,
          max_tokens: c.maxOutputTokens,
          ...(c.system
            ? { system: [{ type: 'text' as const, text: c.system, cache_control: { type: 'ephemeral' } }] }
            : {}),
          messages: [
            {
              role: 'user',
              content: c.images?.length
                ? [
                    { type: 'text', text: c.prompt },
                    ...c.images.map((i) => ({
                      type: 'image' as const,
                      source: { type: 'base64' as const, media_type: i.mediaType, data: i.data },
                    })),
                  ]
                : c.prompt,
            },
          ],
          output_config: { effort: this.effort, format: { type: 'json_schema', schema: c.jsonSchema } },
        },
        { signal: c.signal },
      );
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        const status = err.status ?? 0;
        throw new LlmCallError(
          `LLM API error ${status}: ${err.message}`,
          status === 0 || status === 429 || status >= 500,
        );
      }
      throw new LlmCallError(`LLM API call failed: ${(err as Error).message}`, true);
    }
    if (msg.stop_reason === 'refusal')
      throw new LlmCallError('the model declined the request (refusal)', false);
    if (msg.stop_reason === 'max_tokens') throw new LlmCallError('answer cut off at max_tokens', false);
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    let output: unknown;
    try {
      output = JSON.parse(text);
    } catch {
      output = text;
    }
    const usage = {
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
      cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
    };
    return { output, usage: { ...usage, costUsdEstimate: estimateCostUsd(c.model, usage) } };
  }
}
