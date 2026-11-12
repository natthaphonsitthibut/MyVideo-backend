/**
 * LlmPort (ARCHITECTURE §9, D-009): the only way domain code asks a language model anything. Provider-neutral —
 * no vendor names or types here. The model only reads text and answers in JSON validated by a schema; it never
 * acts. `LLM_MODE` picks who answers: a hosted `api`, a `local-agent` CLI on the developer machine, or nobody
 * (`rules` — callers use the rule-based pass instead).
 */
export const LLM_MODES = ['api', 'local-agent', 'rules'] as const;
export type LlmMode = (typeof LLM_MODES)[number];

/** Which configured model: `fast` = cheapest that passes the eval, `smart` = for harder steps. */
export type LlmTier = 'fast' | 'smart';

/** A JSON schema for the model plus the validator that checks what comes back (never trust the model alone). */
export type StructuredSchema<T> = {
  name: string;
  jsonSchema: Record<string, unknown>;
  parse: (value: unknown) => { ok: true; value: T } | { ok: false; error: string };
};

export type LlmRequest<T> = {
  schema: StructuredSchema<T>;
  /** Stable instructions (cacheable prefix). */
  system?: string;
  /** The per-call input. */
  prompt: string;
  /** Version of the prompt file; part of the cache key. */
  promptVersion: string;
  tier?: LlmTier;
  maxOutputTokens?: number;
};

/** Who is asking: rows and budgets are per merchant, the call cap is per workflow run. */
export type LlmCallContext = { merchantId: string; workflowRunId?: string | null; signal?: AbortSignal };

export type LlmUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** List-price estimate in USD (not a bill; a subscription CLI is not billed per call). */
  costUsdEstimate: number | null;
};

export type LlmResult<T> = {
  value: T;
  mode: LlmMode;
  model: string;
  /** True when the answer came from the result cache (no model call, no cost). */
  cached: boolean;
  /** Model calls made for this answer: 1, or 2 when a repair attempt was needed (0 when cached). */
  calls: number;
  usage: LlmUsage;
  durationMs: number;
};

export interface LlmPort {
  readonly mode: LlmMode;
  generateStructured<T>(request: LlmRequest<T>, context: LlmCallContext): Promise<LlmResult<T>>;
}

/** `rules` mode: there is no model; callers must use the rule-based result. */
export class LlmUnavailableError extends Error {
  constructor(readonly mode: LlmMode) {
    super(`no language model in LLM_MODE=${mode}`);
    this.name = 'LlmUnavailableError';
  }
}

/** The run already used its `LLM_MAX_CALLS_PER_RUN` calls. */
export class LlmBudgetError extends Error {
  constructor(
    readonly workflowRunId: string,
    readonly cap: number,
  ) {
    super(`LLM call cap reached for run ${workflowRunId} (${cap} calls)`);
    this.name = 'LlmBudgetError';
  }
}

/** The model's answer did not match the schema, also after the repair attempt. */
export class LlmInvalidOutputError extends Error {
  constructor(
    readonly schemaName: string,
    readonly detail: string,
  ) {
    super(`LLM output does not match ${schemaName}: ${detail}`);
    this.name = 'LlmInvalidOutputError';
  }
}

/** The model call itself failed (process error, HTTP error, refusal, timeout). */
export class LlmCallError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LlmCallError';
  }
}
