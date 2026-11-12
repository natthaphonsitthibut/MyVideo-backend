import { MigrationInterface, QueryRunner } from 'typeorm';

export class LlmCalls1794465998262 implements MigrationInterface {
  name = 'LlmCalls1794465998262';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "llm_calls" ("id" uuid NOT NULL DEFAULT uuidv7(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "merchant_id" uuid NOT NULL, "workflow_run_id" uuid, "cache_key" text NOT NULL, "mode" text NOT NULL, "model" text NOT NULL, "prompt_version" text NOT NULL, "schema_name" text NOT NULL, "attempt" integer NOT NULL, "status" text NOT NULL, "input_tokens" integer NOT NULL DEFAULT '0', "output_tokens" integer NOT NULL DEFAULT '0', "cache_read_tokens" integer NOT NULL DEFAULT '0', "cache_write_tokens" integer NOT NULL DEFAULT '0', "cost_usd_estimate" double precision, "duration_ms" integer NOT NULL, "output" jsonb, "error" text, CONSTRAINT "llm_calls_attempt_valid" CHECK (attempt >= 1), CONSTRAINT "llm_calls_status_valid" CHECK (status IN ('ok', 'invalid', 'error')), CONSTRAINT "llm_calls_mode_valid" CHECK (mode IN ('api', 'local-agent', 'rules')), CONSTRAINT "PK_927dd9d5a428274e38a05706af8" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "llm_calls_workflow_run_id_idx" ON "llm_calls"  ("workflow_run_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "llm_calls_cache_idx" ON "llm_calls"  ("merchant_id", "cache_key", "created_at") `,
    );
    await queryRunner.query(
      `ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_workflow_run_id_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "llm_calls" DROP CONSTRAINT "llm_calls_workflow_run_id_fkey"`);
    await queryRunner.query(`ALTER TABLE "llm_calls" DROP CONSTRAINT "llm_calls_merchant_id_fkey"`);
    await queryRunner.query(`DROP INDEX "public"."llm_calls_cache_idx"`);
    await queryRunner.query(`DROP INDEX "public"."llm_calls_workflow_run_id_idx"`);
    await queryRunner.query(`DROP TABLE "llm_calls"`);
  }
}
