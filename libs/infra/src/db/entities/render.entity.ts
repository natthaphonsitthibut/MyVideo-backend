import { RENDER_PRESETS, type RenderPreset } from '@myvideo/domain';
import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseRow } from './base.js';
import { MerchantEntity } from './merchant.entity.js';
import { ProjectEntity, ProjectVersionEntity } from './project.entity.js';
import { WorkflowRunEntity } from './workflow-run.entity.js';

const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ');

/**
 * One MP4 export of one pinned project version (ARCHITECTURE §4 Render). The row is unique per cache key
 * (version + preset + stage version) and its output columns are written once, by the render job that holds
 * `workflow_run_id`. Status is the run's (pending/running/succeeded/failed/cancelled).
 */
@Entity({ name: 'renders' })
@Check('renders_preset_valid', `preset IN (${list(RENDER_PRESETS)})`)
@Check('renders_output_complete', `(output_key IS NULL) = (size_bytes IS NULL)`)
@Index('renders_cache_key', ['merchantId', 'cacheKey'], { unique: true })
@Index('renders_project_created_idx', ['projectId', 'createdAt'])
@Index('renders_project_version_id_idx', ['projectVersionId'])
@Index('renders_workflow_run_id_idx', ['workflowRunId'])
export class RenderEntity extends BaseRow {
  @Column({ name: 'merchant_id', type: 'uuid' })
  merchantId!: string;

  @ManyToOne(() => MerchantEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'merchant_id', foreignKeyConstraintName: 'renders_merchant_id_fkey' })
  merchant?: MerchantEntity;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'project_id', foreignKeyConstraintName: 'renders_project_id_fkey' })
  project?: ProjectEntity;

  @Column({ name: 'project_version_id', type: 'uuid' })
  projectVersionId!: string;

  @ManyToOne(() => ProjectVersionEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'project_version_id', foreignKeyConstraintName: 'renders_project_version_id_fkey' })
  projectVersionRow?: ProjectVersionEntity;

  /** The version number, kept for display. */
  @Column({ name: 'project_version', type: 'integer' })
  projectVersion!: number;

  @Column({ type: 'text' })
  preset!: RenderPreset;

  @Column({ name: 'stage_version', type: 'text' })
  stageVersion!: string;

  @Column({ name: 'cache_key', type: 'text' })
  cacheKey!: string;

  @Column({ name: 'workflow_run_id', type: 'uuid', nullable: true })
  workflowRunId!: string | null;

  @ManyToOne(() => WorkflowRunEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'workflow_run_id', foreignKeyConstraintName: 'renders_workflow_run_id_fkey' })
  workflowRun?: WorkflowRunEntity;

  @Column({ name: 'output_key', type: 'text', nullable: true })
  outputKey!: string | null;

  @Column({ name: 'size_bytes', type: 'bigint', nullable: true })
  sizeBytes!: string | null;

  @Column({ type: 'text', nullable: true })
  sha256!: string | null;

  /** Probe of the output + render timings. */
  @Column({ type: 'jsonb', default: {} })
  meta!: Record<string, unknown>;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt!: Date | null;
}
