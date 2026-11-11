import { MigrationInterface, QueryRunner } from 'typeorm';

export class JobsBackbone1794437290673 implements MigrationInterface {
  name = 'JobsBackbone1794437290673';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "workflow_runs" ("id" uuid NOT NULL DEFAULT uuidv7(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "merchant_id" uuid NOT NULL, "kind" text NOT NULL, "status" text NOT NULL DEFAULT 'pending', "subject_type" text, "subject_id" uuid, "input" jsonb NOT NULL DEFAULT '{}', "error" jsonb, "finished_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "workflow_runs_kind_valid" CHECK (kind IN ('ingest', 'transcribe', 'live_to_clips', 'review_to_video', 'render', 'system_test')), CONSTRAINT "workflow_runs_status_valid" CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')), CONSTRAINT "PK_eea9f8d0a660b3f48114c313233" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "workflow_runs_subject_idx" ON "workflow_runs"  ("subject_id") `);
    await queryRunner.query(
      `CREATE INDEX "workflow_runs_merchant_created_idx" ON "workflow_runs"  ("merchant_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE TABLE "jobs" ("id" uuid NOT NULL DEFAULT uuidv7(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "merchant_id" uuid NOT NULL, "workflow_run_id" uuid NOT NULL, "type" text NOT NULL, "queue" text NOT NULL, "step_index" integer NOT NULL DEFAULT '0', "payload" jsonb NOT NULL DEFAULT '{}', "status" text NOT NULL DEFAULT 'pending', "idempotency_key" text NOT NULL, "attempts" integer NOT NULL DEFAULT '0', "max_attempts" integer NOT NULL DEFAULT '3', "run_after" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "locked_by" text, "heartbeat_at" TIMESTAMP WITH TIME ZONE, "cancel_requested" boolean NOT NULL DEFAULT false, "timeout_ms" integer NOT NULL DEFAULT '600000', "progress" real NOT NULL DEFAULT '0', "error" jsonb, "result" jsonb, "started_at" TIMESTAMP WITH TIME ZONE, "finished_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "jobs_type_not_blank" CHECK (length(type) > 0), CONSTRAINT "jobs_timeout_valid" CHECK (timeout_ms > 0), CONSTRAINT "jobs_progress_valid" CHECK (progress >= 0 AND progress <= 1), CONSTRAINT "jobs_attempts_valid" CHECK (attempts >= 0 AND max_attempts >= 1 AND attempts <= max_attempts), CONSTRAINT "jobs_queue_valid" CHECK (queue IN ('media', 'ai', 'render')), CONSTRAINT "jobs_status_valid" CHECK (status IN ('pending', 'queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled')), CONSTRAINT "PK_cf0a6c42b72fcc7f7c237def345" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "jobs_workflow_run_id_idx" ON "jobs"  ("workflow_run_id") `);
    await queryRunner.query(`CREATE INDEX "jobs_merchant_status_idx" ON "jobs"  ("merchant_id", "status") `);
    await queryRunner.query(
      `CREATE INDEX "jobs_running_heartbeat_idx" ON "jobs"  ("heartbeat_at") WHERE status = 'running'`,
    );
    await queryRunner.query(
      `CREATE INDEX "jobs_dispatch_idx" ON "jobs"  ("run_after") WHERE status = 'pending'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "jobs_merchant_idempotency_key" ON "jobs"  ("merchant_id", "idempotency_key") `,
    );
    await queryRunner.query(
      `CREATE TABLE "job_attempts" ("id" uuid NOT NULL DEFAULT uuidv7(), "merchant_id" uuid NOT NULL, "job_id" uuid NOT NULL, "attempt_no" integer NOT NULL, "worker_id" text NOT NULL, "status" text NOT NULL DEFAULT 'running', "error" jsonb, "started_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "finished_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "job_attempts_no_valid" CHECK (attempt_no >= 1), CONSTRAINT "job_attempts_status_valid" CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled', 'timed_out')), CONSTRAINT "PK_61deab46f06c9ab9d5585b28423" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "job_attempts_merchant_id_idx" ON "job_attempts"  ("merchant_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "job_attempts_job_attempt_key" ON "job_attempts"  ("job_id", "attempt_no") `,
    );
    await queryRunner.query(
      `ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD CONSTRAINT "jobs_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workflow_run_id_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "job_attempts" DROP CONSTRAINT "job_attempts_job_id_fkey"`);
    await queryRunner.query(`ALTER TABLE "job_attempts" DROP CONSTRAINT "job_attempts_merchant_id_fkey"`);
    await queryRunner.query(`ALTER TABLE "jobs" DROP CONSTRAINT "jobs_workflow_run_id_fkey"`);
    await queryRunner.query(`ALTER TABLE "jobs" DROP CONSTRAINT "jobs_merchant_id_fkey"`);
    await queryRunner.query(`ALTER TABLE "workflow_runs" DROP CONSTRAINT "workflow_runs_merchant_id_fkey"`);
    await queryRunner.query(`DROP INDEX "public"."job_attempts_job_attempt_key"`);
    await queryRunner.query(`DROP INDEX "public"."job_attempts_merchant_id_idx"`);
    await queryRunner.query(`DROP TABLE "job_attempts"`);
    await queryRunner.query(`DROP INDEX "public"."jobs_merchant_idempotency_key"`);
    await queryRunner.query(`DROP INDEX "public"."jobs_dispatch_idx"`);
    await queryRunner.query(`DROP INDEX "public"."jobs_running_heartbeat_idx"`);
    await queryRunner.query(`DROP INDEX "public"."jobs_merchant_status_idx"`);
    await queryRunner.query(`DROP INDEX "public"."jobs_workflow_run_id_idx"`);
    await queryRunner.query(`DROP TABLE "jobs"`);
    await queryRunner.query(`DROP INDEX "public"."workflow_runs_merchant_created_idx"`);
    await queryRunner.query(`DROP INDEX "public"."workflow_runs_subject_idx"`);
    await queryRunner.query(`DROP TABLE "workflow_runs"`);
  }
}
