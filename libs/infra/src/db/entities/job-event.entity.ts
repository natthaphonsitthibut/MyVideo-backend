import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Append-only change feed for live progress (SSE). Written by triggers on `jobs` and `workflow_runs`, which also
 * `NOTIFY job_events`. The bigint id is the SSE event id: a reconnect replays `id > Last-Event-ID`.
 * No FKs on purpose (feed rows outlive nothing, they are cleaned by retention in E11).
 */
@Entity({ name: 'job_events' })
@Check('job_events_kind_valid', `kind IN ('job', 'run')`)
@Index('job_events_run_id_idx', ['workflowRunId', 'id'])
@Index('job_events_merchant_id_idx', ['merchantId'])
export class JobEventEntity {
  @PrimaryGeneratedColumn('identity', { type: 'bigint', generatedIdentity: 'ALWAYS' })
  id!: string;

  @Column({ name: 'merchant_id', type: 'uuid' })
  merchantId!: string;

  @Column({ name: 'workflow_run_id', type: 'uuid' })
  workflowRunId!: string;

  @Column({ name: 'job_id', type: 'uuid', nullable: true })
  jobId!: string | null;

  @Column({ type: 'text' })
  kind!: 'job' | 'run';

  @Column({ type: 'text' })
  status!: string;

  @Column({ type: 'real', nullable: true })
  progress!: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
