import { MigrationInterface, QueryRunner } from 'typeorm';

export class ShotAnalyses1794467847630 implements MigrationInterface {
  name = 'ShotAnalyses1794467847630';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "analyses" ("id" uuid NOT NULL DEFAULT uuidv7(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "merchant_id" uuid NOT NULL, "source_id" uuid NOT NULL, "kind" text NOT NULL, "recipe_version" integer NOT NULL, "engine" text, "status" text NOT NULL DEFAULT 'running', "parts" jsonb NOT NULL DEFAULT '[]', "error" text, CONSTRAINT "analyses_status_valid" CHECK (status IN ('running', 'ready', 'failed')), CONSTRAINT "analyses_kind_valid" CHECK (kind IN ('shots')), CONSTRAINT "PK_91421900ca225ed9865d016a940" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "analyses_merchant_id_idx" ON "analyses"  ("merchant_id") `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "analyses_cache_key" ON "analyses"  ("source_id", "kind", "recipe_version") `,
    );
    await queryRunner.query(
      `CREATE TABLE "detected_shots" ("id" uuid NOT NULL DEFAULT uuidv7(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "merchant_id" uuid NOT NULL, "analysis_id" uuid NOT NULL, "seq" integer NOT NULL, "start_ms" integer NOT NULL, "end_ms" integer NOT NULL, "keyframes" jsonb NOT NULL DEFAULT '[]', CONSTRAINT "detected_shots_span_valid" CHECK (start_ms >= 0 AND end_ms > start_ms), CONSTRAINT "PK_56fa5f6529333290abcaa3efc1f" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "detected_shots_merchant_id_idx" ON "detected_shots"  ("merchant_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "detected_shots_analysis_seq_key" ON "detected_shots"  ("analysis_id", "seq") `,
    );
    await queryRunner.query(
      `ALTER TABLE "analyses" ADD CONSTRAINT "analyses_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "analyses" ADD CONSTRAINT "analyses_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "video_sources"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "detected_shots" ADD CONSTRAINT "detected_shots_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "detected_shots" ADD CONSTRAINT "detected_shots_analysis_id_fkey" FOREIGN KEY ("analysis_id") REFERENCES "analyses"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "detected_shots" DROP CONSTRAINT "detected_shots_analysis_id_fkey"`);
    await queryRunner.query(`ALTER TABLE "detected_shots" DROP CONSTRAINT "detected_shots_merchant_id_fkey"`);
    await queryRunner.query(`ALTER TABLE "analyses" DROP CONSTRAINT "analyses_source_id_fkey"`);
    await queryRunner.query(`ALTER TABLE "analyses" DROP CONSTRAINT "analyses_merchant_id_fkey"`);
    await queryRunner.query(`DROP INDEX "public"."detected_shots_analysis_seq_key"`);
    await queryRunner.query(`DROP INDEX "public"."detected_shots_merchant_id_idx"`);
    await queryRunner.query(`DROP TABLE "detected_shots"`);
    await queryRunner.query(`DROP INDEX "public"."analyses_cache_key"`);
    await queryRunner.query(`DROP INDEX "public"."analyses_merchant_id_idx"`);
    await queryRunner.query(`DROP TABLE "analyses"`);
  }
}
