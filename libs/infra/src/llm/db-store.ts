import type { DataSource } from 'typeorm';
import { LlmCallEntity } from '../db/entities/llm-call.entity.js';
import type { LlmCallRecord, LlmCallStore } from './structured-llm.js';

/** `llm_calls` table: result cache (scoped by merchant), per-run call count, cost log. */
export class DbLlmCallStore implements LlmCallStore {
  constructor(private readonly ds: DataSource) {}

  async findCached(merchantId: string, cacheKey: string): Promise<unknown | undefined> {
    const row = await this.ds.getRepository(LlmCallEntity).findOne({
      where: { merchantId, cacheKey, status: 'ok' },
      order: { createdAt: 'DESC' },
    });
    return row ? row.output : undefined;
  }

  countCalls(workflowRunId: string): Promise<number> {
    return this.ds.getRepository(LlmCallEntity).count({ where: { workflowRunId } });
  }

  async record(r: LlmCallRecord): Promise<void> {
    await this.ds.getRepository(LlmCallEntity).insert({
      merchantId: r.merchantId,
      workflowRunId: r.workflowRunId,
      cacheKey: r.cacheKey,
      mode: r.mode,
      model: r.model,
      promptVersion: r.promptVersion,
      schemaName: r.schemaName,
      attempt: r.attempt,
      status: r.status,
      inputTokens: r.usage.inputTokens,
      outputTokens: r.usage.outputTokens,
      cacheReadTokens: r.usage.cacheReadTokens,
      cacheWriteTokens: r.usage.cacheWriteTokens,
      costUsdEstimate: r.usage.costUsdEstimate,
      durationMs: r.durationMs,
      output: (r.output ?? null) as object | null,
      error: r.error,
    });
  }
}
