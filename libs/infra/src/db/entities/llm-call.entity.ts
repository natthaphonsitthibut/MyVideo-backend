import { LLM_MODES, type LlmMode } from '@myvideo/domain';
import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseRow } from './base.js';
import { MerchantEntity } from './merchant.entity.js';
import { WorkflowRunEntity } from './workflow-run.entity.js';

const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ');

/**
 * One language-model call (E07-F02): the result cache (newest `ok` row per merchant + cache key), the per-run
 * call cap (rows per run) and the cost log (tokens, list-price estimate). Cache hits write no row.
 */
@Entity({ name: 'llm_calls' })
@Check('llm_calls_mode_valid', `mode IN (${list(LLM_MODES)})`)
@Check('llm_calls_status_valid', `status IN ('ok', 'invalid', 'error')`)
@Check('llm_calls_attempt_valid', `attempt >= 1`)
@Index('llm_calls_cache_idx', ['merchantId', 'cacheKey', 'createdAt'])
@Index('llm_calls_workflow_run_id_idx', ['workflowRunId'])
export class LlmCallEntity extends BaseRow {
  @Column({ name: 'merchant_id', type: 'uuid' })
  merchantId!: string;

  @ManyToOne(() => MerchantEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'merchant_id', foreignKeyConstraintName: 'llm_calls_merchant_id_fkey' })
  merchant?: MerchantEntity;

  @Column({ name: 'workflow_run_id', type: 'uuid', nullable: true })
  workflowRunId!: string | null;

  @ManyToOne(() => WorkflowRunEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'workflow_run_id', foreignKeyConstraintName: 'llm_calls_workflow_run_id_fkey' })
  workflowRun?: WorkflowRunEntity;

  @Column({ name: 'cache_key', type: 'text' })
  cacheKey!: string;

  @Column({ type: 'text' })
  mode!: LlmMode;

  @Column({ type: 'text' })
  model!: string;

  @Column({ name: 'prompt_version', type: 'text' })
  promptVersion!: string;

  @Column({ name: 'schema_name', type: 'text' })
  schemaName!: string;

  @Column({ type: 'integer' })
  attempt!: number;

  @Column({ type: 'text' })
  status!: 'ok' | 'invalid' | 'error';

  @Column({ name: 'input_tokens', type: 'integer', default: 0 })
  inputTokens!: number;

  @Column({ name: 'output_tokens', type: 'integer', default: 0 })
  outputTokens!: number;

  @Column({ name: 'cache_read_tokens', type: 'integer', default: 0 })
  cacheReadTokens!: number;

  @Column({ name: 'cache_write_tokens', type: 'integer', default: 0 })
  cacheWriteTokens!: number;

  /** List-price estimate, not a bill. */
  @Column({ name: 'cost_usd_estimate', type: 'double precision', nullable: true })
  costUsdEstimate!: number | null;

  @Column({ name: 'duration_ms', type: 'integer' })
  durationMs!: number;

  @Column({ type: 'jsonb', nullable: true })
  output!: object | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;
}
