import { MigrationInterface, QueryRunner } from 'typeorm';

export class Renders1794460818268 implements MigrationInterface {
  name = 'Renders1794460818268';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "renders" ("id" uuid NOT NULL DEFAULT uuidv7(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "merchant_id" uuid NOT NULL, "project_id" uuid NOT NULL, "project_version_id" uuid NOT NULL, "project_version" integer NOT NULL, "preset" text NOT NULL, "stage_version" text NOT NULL, "cache_key" text NOT NULL, "workflow_run_id" uuid, "output_key" text, "size_bytes" bigint, "sha256" text, "meta" jsonb NOT NULL DEFAULT '{}', "finished_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "renders_output_complete" CHECK ((output_key IS NULL) = (size_bytes IS NULL)), CONSTRAINT "renders_preset_valid" CHECK (preset IN ('standard', 'high')), CONSTRAINT "PK_a5678fd96b9b0f258b93177c4d1" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "renders_workflow_run_id_idx" ON "renders"  ("workflow_run_id") `);
    await queryRunner.query(
      `CREATE INDEX "renders_project_version_id_idx" ON "renders"  ("project_version_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "renders_project_created_idx" ON "renders"  ("project_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "renders_cache_key" ON "renders"  ("merchant_id", "cache_key") `,
    );
    await queryRunner.query(
      `ALTER TABLE "renders" ADD CONSTRAINT "renders_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "renders" ADD CONSTRAINT "renders_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "renders" ADD CONSTRAINT "renders_project_version_id_fkey" FOREIGN KEY ("project_version_id") REFERENCES "project_versions"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "renders" ADD CONSTRAINT "renders_workflow_run_id_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "renders" DROP CONSTRAINT "renders_workflow_run_id_fkey"`);
    await queryRunner.query(`ALTER TABLE "renders" DROP CONSTRAINT "renders_project_version_id_fkey"`);
    await queryRunner.query(`ALTER TABLE "renders" DROP CONSTRAINT "renders_project_id_fkey"`);
    await queryRunner.query(`ALTER TABLE "renders" DROP CONSTRAINT "renders_merchant_id_fkey"`);
    await queryRunner.query(`DROP INDEX "public"."renders_cache_key"`);
    await queryRunner.query(`DROP INDEX "public"."renders_project_created_idx"`);
    await queryRunner.query(`DROP INDEX "public"."renders_project_version_id_idx"`);
    await queryRunner.query(`DROP INDEX "public"."renders_workflow_run_id_idx"`);
    await queryRunner.query(`DROP TABLE "renders"`);
  }
}
