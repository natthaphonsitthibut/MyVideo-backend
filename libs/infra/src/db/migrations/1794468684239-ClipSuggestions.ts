import { MigrationInterface, QueryRunner } from 'typeorm';

export class ClipSuggestions1794468684239 implements MigrationInterface {
  name = 'ClipSuggestions1794468684239';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "clip_suggestions" ("id" uuid NOT NULL DEFAULT uuidv7(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "merchant_id" uuid NOT NULL, "source_id" uuid NOT NULL, "workflow_run_id" uuid NOT NULL, "rank" integer NOT NULL, "status" text NOT NULL DEFAULT 'planned', "start_ms" integer NOT NULL, "end_ms" integer NOT NULL, "start_word" integer NOT NULL, "end_word" integer NOT NULL, "score" real NOT NULL, "type" text NOT NULL, "reason" text NOT NULL, "quote" text, "hook" text, "title" text NOT NULL, "origin" text NOT NULL, "mode" text NOT NULL, "project_id" uuid, "error" text, CONSTRAINT "clip_suggestions_rank_valid" CHECK (rank >= 1), CONSTRAINT "clip_suggestions_span_valid" CHECK (start_ms >= 0 AND end_ms > start_ms), CONSTRAINT "clip_suggestions_status_valid" CHECK (status IN ('planned', 'ready', 'failed', 'discarded')), CONSTRAINT "PK_7a2f87529effd150fbe8b4113b2" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "clip_suggestions_project_id_idx" ON "clip_suggestions"  ("project_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "clip_suggestions_merchant_id_idx" ON "clip_suggestions"  ("merchant_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "clip_suggestions_source_idx" ON "clip_suggestions"  ("source_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "clip_suggestions_run_rank_key" ON "clip_suggestions"  ("workflow_run_id", "rank") `,
    );
    await queryRunner.query(
      `ALTER TABLE "clip_suggestions" ADD CONSTRAINT "clip_suggestions_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "clip_suggestions" ADD CONSTRAINT "clip_suggestions_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "video_sources"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "clip_suggestions" ADD CONSTRAINT "clip_suggestions_workflow_run_id_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "clip_suggestions" ADD CONSTRAINT "clip_suggestions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "clip_suggestions" DROP CONSTRAINT "clip_suggestions_project_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "clip_suggestions" DROP CONSTRAINT "clip_suggestions_workflow_run_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "clip_suggestions" DROP CONSTRAINT "clip_suggestions_source_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "clip_suggestions" DROP CONSTRAINT "clip_suggestions_merchant_id_fkey"`,
    );
    await queryRunner.query(`DROP INDEX "public"."clip_suggestions_run_rank_key"`);
    await queryRunner.query(`DROP INDEX "public"."clip_suggestions_source_idx"`);
    await queryRunner.query(`DROP INDEX "public"."clip_suggestions_merchant_id_idx"`);
    await queryRunner.query(`DROP INDEX "public"."clip_suggestions_project_id_idx"`);
    await queryRunner.query(`DROP TABLE "clip_suggestions"`);
  }
}
