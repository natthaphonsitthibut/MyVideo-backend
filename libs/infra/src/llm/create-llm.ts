import type { LlmPort } from '@myvideo/domain';
import type { Env } from '../config/env.js';
import type { LlmAdapter } from './adapter.js';
import { AnthropicApiAdapter } from './api-anthropic.js';
import { ClaudeCliAdapter } from './local-agent-claude.js';
import { type LlmCallStore, RulesOnlyLlm, StructuredLlm } from './structured-llm.js';

type LlmEnv = Pick<
  Env,
  | 'LLM_MODE'
  | 'LLM_PROVIDER'
  | 'LLM_API_KEY'
  | 'LLM_BASE_URL'
  | 'LLM_MODEL_FAST'
  | 'LLM_MODEL_SMART'
  | 'LLM_EFFORT'
  | 'LOCAL_AGENT_CLI'
  | 'LLM_MAX_CALLS_PER_RUN'
  | 'NODE_ENV'
>;

export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmConfigError';
  }
}

/** Picks the adapter for `LLM_MODE` (D-009). Env validation already refuses local-agent in production. */
export function createLlmAdapter(env: LlmEnv): LlmAdapter | null {
  const models = { fast: env.LLM_MODEL_FAST, smart: env.LLM_MODEL_SMART };
  switch (env.LLM_MODE) {
    case 'rules':
      return null;
    case 'local-agent':
      if (env.NODE_ENV === 'production')
        throw new LlmConfigError('local-agent is refused in production (D-009)');
      if (env.LOCAL_AGENT_CLI !== 'claude') {
        throw new LlmConfigError(
          `LOCAL_AGENT_CLI=${env.LOCAL_AGENT_CLI} has no adapter yet (supported: claude)`,
        );
      }
      return new ClaudeCliAdapter({ models, effort: env.LLM_EFFORT });
    case 'api':
      if (env.LLM_PROVIDER !== 'anthropic') {
        throw new LlmConfigError(
          `LLM_PROVIDER=${env.LLM_PROVIDER ?? ''} has no adapter yet (supported: anthropic)`,
        );
      }
      if (!env.LLM_API_KEY) throw new LlmConfigError('LLM_MODE=api needs LLM_API_KEY');
      return new AnthropicApiAdapter({
        apiKey: env.LLM_API_KEY,
        baseURL: env.LLM_BASE_URL,
        models,
        effort: env.LLM_EFFORT,
      });
  }
}

export function createLlm(env: LlmEnv, store: LlmCallStore): LlmPort {
  const adapter = createLlmAdapter(env);
  if (!adapter) return new RulesOnlyLlm();
  return new StructuredLlm(adapter, store, { maxCallsPerRun: env.LLM_MAX_CALLS_PER_RUN });
}
