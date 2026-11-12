import { createHash } from 'node:crypto';
import {
  LlmBudgetError,
  type LlmCallContext,
  LlmCallError,
  LlmInvalidOutputError,
  type LlmMode,
  type LlmPort,
  type LlmRequest,
  type LlmResult,
  LlmUnavailableError,
  type LlmUsage,
} from '@myvideo/domain';
import type { LlmAdapter } from './adapter.js';

export type LlmCallStatus = 'ok' | 'invalid' | 'error';

/** One model call (never written for a cache hit). The table behind it is the cost/eval log of E07-F09. */
export type LlmCallRecord = {
  merchantId: string;
  workflowRunId: string | null;
  cacheKey: string;
  mode: LlmMode;
  model: string;
  promptVersion: string;
  schemaName: string;
  attempt: number;
  status: LlmCallStatus;
  usage: LlmUsage;
  durationMs: number;
  output: unknown;
  error: string | null;
};

export interface LlmCallStore {
  /** The newest `ok` output for this key and merchant, if any. */
  findCached(merchantId: string, cacheKey: string): Promise<unknown | undefined>;
  /** Model calls already made for a run (all statuses). */
  countCalls(workflowRunId: string): Promise<number>;
  record(row: LlmCallRecord): Promise<void>;
}

export class MemoryLlmCallStore implements LlmCallStore {
  readonly rows: LlmCallRecord[] = [];

  async findCached(merchantId: string, cacheKey: string) {
    const hit = [...this.rows]
      .reverse()
      .find((r) => r.merchantId === merchantId && r.cacheKey === cacheKey && r.status === 'ok');
    return hit?.output;
  }

  async countCalls(workflowRunId: string) {
    return this.rows.filter((r) => r.workflowRunId === workflowRunId).length;
  }

  async record(row: LlmCallRecord) {
    this.rows.push(row);
  }
}

const ZERO: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsdEstimate: 0,
};

function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsdEstimate:
      a.costUsdEstimate === null || b.costUsdEstimate === null ? null : a.costUsdEstimate + b.costUsdEstimate,
  };
}

/** Cache key = hash of (mode, model, prompt version, schema, instructions, input). */
export function llmCacheKey(mode: LlmMode, model: string, req: LlmRequest<unknown>): string {
  const h = createHash('sha256');
  h.update(
    JSON.stringify([
      mode,
      model,
      req.promptVersion,
      req.schema.name,
      req.schema.jsonSchema,
      req.system ?? '',
      req.prompt,
    ]),
  );
  return h.digest('hex');
}

/**
 * The shared part of every adapter (E07-F02): result cache, per-run call cap, schema validation with one repair
 * attempt, and a record of every model call. Adapters only make the raw call.
 */
export class StructuredLlm implements LlmPort {
  readonly mode: LlmMode;

  constructor(
    private readonly adapter: LlmAdapter,
    private readonly store: LlmCallStore,
    private readonly opts: { maxCallsPerRun: number },
  ) {
    this.mode = adapter.mode;
  }

  async generateStructured<T>(req: LlmRequest<T>, ctx: LlmCallContext): Promise<LlmResult<T>> {
    const started = performance.now();
    const model = this.adapter.modelFor(req.tier ?? 'fast');
    const key = llmCacheKey(this.mode, model, req as LlmRequest<unknown>);

    const cached = await this.store.findCached(ctx.merchantId, key);
    if (cached !== undefined) {
      const p = req.schema.parse(cached);
      if (p.ok) {
        return { value: p.value, mode: this.mode, model, cached: true, calls: 0, usage: ZERO, durationMs: 0 };
      }
    }

    let usage = ZERO;
    let prompt = req.prompt;
    let lastError = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      const runId = ctx.workflowRunId ?? null;
      if (runId && (await this.store.countCalls(runId)) >= this.opts.maxCallsPerRun) {
        throw new LlmBudgetError(runId, this.opts.maxCallsPerRun);
      }
      const t0 = performance.now();
      const base = {
        merchantId: ctx.merchantId,
        workflowRunId: runId,
        cacheKey: key,
        mode: this.mode,
        model,
        promptVersion: req.promptVersion,
        schemaName: req.schema.name,
        attempt,
      };
      let result: Awaited<ReturnType<LlmAdapter['call']>>;
      try {
        result = await this.adapter.call({
          system: req.system,
          prompt,
          jsonSchema: req.schema.jsonSchema,
          model,
          maxOutputTokens: req.maxOutputTokens ?? 4096,
        });
      } catch (err) {
        await this.store.record({
          ...base,
          status: 'error',
          usage: ZERO,
          durationMs: Math.round(performance.now() - t0),
          output: null,
          error: (err as Error).message.slice(0, 1000),
        });
        if (err instanceof LlmCallError) throw err;
        throw new LlmCallError((err as Error).message, true);
      }
      usage = addUsage(usage, result.usage);
      const parsed = req.schema.parse(result.output);
      await this.store.record({
        ...base,
        status: parsed.ok ? 'ok' : 'invalid',
        usage: result.usage,
        durationMs: Math.round(performance.now() - t0),
        output: result.output ?? null,
        error: parsed.ok ? null : parsed.error.slice(0, 1000),
      });
      if (parsed.ok) {
        return {
          value: parsed.value,
          mode: this.mode,
          model,
          cached: false,
          calls: attempt,
          usage,
          durationMs: Math.round(performance.now() - started),
        };
      }
      lastError = parsed.error;
      prompt =
        `${req.prompt}\n\n` +
        `Your previous answer was rejected by the validator: ${parsed.error}\n` +
        `Previous answer: ${JSON.stringify(result.output).slice(0, 4000)}\n` +
        'Answer again. Fix only what the validator rejected and follow every rule above.';
    }
    throw new LlmInvalidOutputError(req.schema.name, lastError);
  }
}

/** `LLM_MODE=rules`: there is no model. Callers check `mode` and use the rule-based pass. */
export class RulesOnlyLlm implements LlmPort {
  readonly mode = 'rules' as const;

  async generateStructured<T>(): Promise<LlmResult<T>> {
    throw new LlmUnavailableError('rules');
  }
}
