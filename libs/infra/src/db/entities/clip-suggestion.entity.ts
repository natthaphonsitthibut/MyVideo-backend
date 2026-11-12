import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseRow } from './base.js';
import { MerchantEntity } from './merchant.entity.js';
import { ProjectEntity } from './project.entity.js';
import { VideoSourceEntity } from './video-source.entity.js';
import { WorkflowRunEntity } from './workflow-run.entity.js';

export const CLIP_SUGGESTION_STATUSES = ['planned', 'ready', 'failed', 'discarded'] as const;
export type ClipSuggestionStatus = (typeof CLIP_SUGGESTION_STATUSES)[number];

const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ');

/**
 * One clip proposed by a live-to-clips run (E07-F08). Written `planned` by `clips.plan`, becomes `ready` when
 * `clips.build` has created its editable project (cards appear one by one), `failed` if that step died, or
 * `discarded` by the merchant. Unique per (run, rank).
 */
@Entity({ name: 'clip_suggestions' })
@Check('clip_suggestions_status_valid', `status IN (${list(CLIP_SUGGESTION_STATUSES)})`)
@Check('clip_suggestions_span_valid', `start_ms >= 0 AND end_ms > start_ms`)
@Check('clip_suggestions_rank_valid', `rank >= 1`)
@Index('clip_suggestions_run_rank_key', ['workflowRunId', 'rank'], { unique: true })
@Index('clip_suggestions_source_idx', ['sourceId', 'createdAt'])
@Index('clip_suggestions_merchant_id_idx', ['merchantId'])
@Index('clip_suggestions_project_id_idx', ['projectId'])
export class ClipSuggestionEntity extends BaseRow {
  @Column({ name: 'merchant_id', type: 'uuid' })
  merchantId!: string;

  @ManyToOne(() => MerchantEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'merchant_id', foreignKeyConstraintName: 'clip_suggestions_merchant_id_fkey' })
  merchant?: MerchantEntity;

  @Column({ name: 'source_id', type: 'uuid' })
  sourceId!: string;

  @ManyToOne(() => VideoSourceEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'source_id', foreignKeyConstraintName: 'clip_suggestions_source_id_fkey' })
  source?: VideoSourceEntity;

  @Column({ name: 'workflow_run_id', type: 'uuid' })
  workflowRunId!: string;

  @ManyToOne(() => WorkflowRunEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'workflow_run_id', foreignKeyConstraintName: 'clip_suggestions_workflow_run_id_fkey' })
  workflowRun?: WorkflowRunEntity;

  @Column({ type: 'integer' })
  rank!: number;

  @Column({ type: 'text', default: 'planned' })
  status!: ClipSuggestionStatus;

  @Column({ name: 'start_ms', type: 'integer' })
  startMs!: number;

  @Column({ name: 'end_ms', type: 'integer' })
  endMs!: number;

  @Column({ name: 'start_word', type: 'integer' })
  startWord!: number;

  @Column({ name: 'end_word', type: 'integer' })
  endWord!: number;

  /** 0–100 (model score in LLM modes, scaled rule score in rules mode). */
  @Column({ type: 'real' })
  score!: number;

  @Column({ type: 'text' })
  type!: string;

  @Column({ type: 'text' })
  reason!: string;

  /** Verbatim transcript phrase backing the reason (LLM modes). */
  @Column({ type: 'text', nullable: true })
  quote!: string | null;

  @Column({ type: 'text', nullable: true })
  hook!: string | null;

  @Column({ type: 'text' })
  title!: string;

  /** Who chose the clip: 'rules' or 'llm'. */
  @Column({ type: 'text' })
  origin!: string;

  @Column({ type: 'text' })
  mode!: string;

  @Column({ name: 'project_id', type: 'uuid', nullable: true })
  projectId!: string | null;

  @ManyToOne(() => ProjectEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'project_id', foreignKeyConstraintName: 'clip_suggestions_project_id_fkey' })
  project?: ProjectEntity;

  @Column({ type: 'text', nullable: true })
  error!: string | null;
}
