import { MigrationInterface, QueryRunner } from 'typeorm';

export class Projects1794455702974 implements MigrationInterface {
  name = 'Projects1794455702974';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "projects" ("id" uuid NOT NULL DEFAULT uuidv7(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "merchant_id" uuid NOT NULL, "title" text NOT NULL, "current_version" integer NOT NULL DEFAULT '1', CONSTRAINT "projects_version_valid" CHECK (current_version >= 1), CONSTRAINT "projects_title_not_blank" CHECK (length(btrim(title)) > 0), CONSTRAINT "PK_6271df0a7aed1d6c0691ce6ac50" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "projects_merchant_updated_idx" ON "projects"  ("merchant_id", "updated_at") `,
    );
    await queryRunner.query(
      `CREATE TABLE "project_versions" ("id" uuid NOT NULL DEFAULT uuidv7(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "merchant_id" uuid NOT NULL, "project_id" uuid NOT NULL, "version" integer NOT NULL, "doc" jsonb NOT NULL, "reason" text NOT NULL, "restored_from" integer, CONSTRAINT "project_versions_reason_valid" CHECK (reason IN ('create', 'save', 'restore')), CONSTRAINT "project_versions_version_valid" CHECK (version >= 1), CONSTRAINT "PK_0933adf663634f5c8c335e7b5e4" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "project_versions_merchant_id_idx" ON "project_versions"  ("merchant_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "project_versions_project_version_key" ON "project_versions"  ("project_id", "version") `,
    );
    await queryRunner.query(
      `ALTER TABLE "projects" ADD CONSTRAINT "projects_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_versions" ADD CONSTRAINT "project_versions_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_versions" ADD CONSTRAINT "project_versions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "project_versions" DROP CONSTRAINT "project_versions_project_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "project_versions" DROP CONSTRAINT "project_versions_merchant_id_fkey"`,
    );
    await queryRunner.query(`ALTER TABLE "projects" DROP CONSTRAINT "projects_merchant_id_fkey"`);
    await queryRunner.query(`DROP INDEX "public"."project_versions_project_version_key"`);
    await queryRunner.query(`DROP INDEX "public"."project_versions_merchant_id_idx"`);
    await queryRunner.query(`DROP TABLE "project_versions"`);
    await queryRunner.query(`DROP INDEX "public"."projects_merchant_updated_idx"`);
    await queryRunner.query(`DROP TABLE "projects"`);
  }
}
