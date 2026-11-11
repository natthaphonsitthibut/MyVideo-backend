import { RUN_STATUSES, type RunStatus, WORKFLOW_KINDS, type WorkflowKind } from '@myvideo/domain';
import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseRow } from './base.js';
import { MerchantEntity } from './merchant.entity.js';

const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ');

/** What was asked: one row per ingest / live-to-clips / render … request. Steps are rows in `jobs`. */
@Entity({ name: 'workflow_runs' })
@Check('workflow_runs_status_valid', `status IN (${list(RUN_STATUSES)})`)
@Check('workflow_runs_kind_valid', `kind IN (${list(WORKFLOW_KINDS)})`)
@Index('workflow_runs_merchant_created_idx', ['merchantId', 'createdAt'])
export class WorkflowRunEntity extends BaseRow {
  @Column({ name: 'merchant_id', type: 'uuid' })
  merchantId!: string;

  @ManyToOne(() => MerchantEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'merchant_id', foreignKeyConstraintName: 'workflow_runs_merchant_id_fkey' })
  merchant?: MerchantEntity;

  @Column({ type: 'text' })
  kind!: WorkflowKind;

  @Column({ type: 'text', default: 'pending' })
  status!: RunStatus;

  /** The thing the run is about (a source, a project…), for listing runs per subject. */
  @Column({ name: 'subject_type', type: 'text', nullable: true })
  subjectType!: string | null;

  @Index('workflow_runs_subject_idx')
  @Column({ name: 'subject_id', type: 'uuid', nullable: true })
  subjectId!: string | null;

  @Column({ type: 'jsonb', default: {} })
  input!: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  error!: Record<string, unknown> | null;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt!: Date | null;
}
