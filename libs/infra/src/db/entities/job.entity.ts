import { JOB_STATUSES, type JobStatus, QUEUES, type QueueName } from '@myvideo/domain';
import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseRow } from './base.js';
import { MerchantEntity } from './merchant.entity.js';
import { WorkflowRunEntity } from './workflow-run.entity.js';

const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ');

/**
 * One step of a workflow run. Postgres is the truth; BullMQ only carries the job id (ARCHITECTURE §5).
 * The row doubles as the outbox: it is written in the same transaction as the domain change.
 */
@Entity({ name: 'jobs' })
@Check('jobs_status_valid', `status IN (${list(JOB_STATUSES)})`)
@Check('jobs_queue_valid', `queue IN (${list(QUEUES)})`)
@Check('jobs_attempts_valid', `attempts >= 0 AND max_attempts >= 1 AND attempts <= max_attempts`)
@Check('jobs_progress_valid', `progress >= 0 AND progress <= 1`)
@Check('jobs_timeout_valid', `timeout_ms > 0`)
@Check('jobs_type_not_blank', `length(type) > 0`)
@Index('jobs_merchant_idempotency_key', ['merchantId', 'idempotencyKey'], { unique: true })
@Index('jobs_dispatch_idx', ['runAfter'], { where: `status = 'pending'` })
@Index('jobs_running_heartbeat_idx', ['heartbeatAt'], { where: `status = 'running'` })
@Index('jobs_merchant_status_idx', ['merchantId', 'status'])
export class JobEntity extends BaseRow {
  @Column({ name: 'merchant_id', type: 'uuid' })
  merchantId!: string;

  @ManyToOne(() => MerchantEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'merchant_id', foreignKeyConstraintName: 'jobs_merchant_id_fkey' })
  merchant?: MerchantEntity;

  @Index('jobs_workflow_run_id_idx')
  @Column({ name: 'workflow_run_id', type: 'uuid' })
  workflowRunId!: string;

  @ManyToOne(() => WorkflowRunEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'workflow_run_id', foreignKeyConstraintName: 'jobs_workflow_run_id_fkey' })
  workflowRun?: WorkflowRunEntity;

  /** Handler name, e.g. `media.probe`, `system.sleep`. */
  @Column({ type: 'text' })
  type!: string;

  @Column({ type: 'text' })
  queue!: QueueName;

  /** Position of this step in its run (0-based). */
  @Column({ name: 'step_index', type: 'integer', default: 0 })
  stepIndex!: number;

  @Column({ type: 'jsonb', default: {} })
  payload!: Record<string, unknown>;

  @Column({ type: 'text', default: 'pending' })
  status!: JobStatus;

  /** Same key twice for one merchant → one job (enforced by the unique index). */
  @Column({ name: 'idempotency_key', type: 'text' })
  idempotencyKey!: string;

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Column({ name: 'max_attempts', type: 'integer', default: 3 })
  maxAttempts!: number;

  @Column({ name: 'run_after', type: 'timestamptz', default: () => 'now()' })
  runAfter!: Date;

  @Column({ name: 'locked_by', type: 'text', nullable: true })
  lockedBy!: string | null;

  @Column({ name: 'heartbeat_at', type: 'timestamptz', nullable: true })
  heartbeatAt!: Date | null;

  @Column({ name: 'cancel_requested', type: 'boolean', default: false })
  cancelRequested!: boolean;

  @Column({ name: 'timeout_ms', type: 'integer', default: 600_000 })
  timeoutMs!: number;

  @Column({ type: 'real', default: 0 })
  progress!: number;

  @Column({ type: 'jsonb', nullable: true })
  error!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  result!: Record<string, unknown> | null;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt!: Date | null;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt!: Date | null;
}
