import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { JobEntity } from './job.entity.js';
import { MerchantEntity } from './merchant.entity.js';

export const ATTEMPT_STATUSES = ['running', 'succeeded', 'failed', 'cancelled', 'timed_out'] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

/** One execution of a job by a worker; kept for debugging and per-step timing. */
@Entity({ name: 'job_attempts' })
@Check('job_attempts_status_valid', `status IN (${ATTEMPT_STATUSES.map((s) => `'${s}'`).join(', ')})`)
@Check('job_attempts_no_valid', `attempt_no >= 1`)
@Index('job_attempts_job_attempt_key', ['jobId', 'attemptNo'], { unique: true })
export class JobAttemptEntity {
  @PrimaryColumn({ type: 'uuid', default: () => 'uuidv7()' })
  id!: string;

  @Index('job_attempts_merchant_id_idx')
  @Column({ name: 'merchant_id', type: 'uuid' })
  merchantId!: string;

  @ManyToOne(() => MerchantEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'merchant_id', foreignKeyConstraintName: 'job_attempts_merchant_id_fkey' })
  merchant?: MerchantEntity;

  @Column({ name: 'job_id', type: 'uuid' })
  jobId!: string;

  @ManyToOne(() => JobEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'job_id', foreignKeyConstraintName: 'job_attempts_job_id_fkey' })
  job?: JobEntity;

  @Column({ name: 'attempt_no', type: 'integer' })
  attemptNo!: number;

  @Column({ name: 'worker_id', type: 'text' })
  workerId!: string;

  @Column({ type: 'text', default: 'running' })
  status!: AttemptStatus;

  @Column({ type: 'jsonb', nullable: true })
  error!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'started_at', type: 'timestamptz' })
  startedAt!: Date;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt!: Date | null;
}
