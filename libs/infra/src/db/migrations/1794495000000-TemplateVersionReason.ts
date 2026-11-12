import type { MigrationInterface, QueryRunner } from 'typeorm';

/** A project version made by applying another template to the same footage (E10-F08). */
export class TemplateVersionReason1794495000000 implements MigrationInterface {
  name = 'TemplateVersionReason1794495000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_versions" DROP CONSTRAINT "project_versions_reason_valid"`);
    await queryRunner.query(
      `ALTER TABLE "project_versions" ADD CONSTRAINT "project_versions_reason_valid" CHECK (reason IN ('create', 'save', 'restore', 'restyle', 'template'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "project_versions" SET reason = 'save' WHERE reason = 'template'`);
    await queryRunner.query(`ALTER TABLE "project_versions" DROP CONSTRAINT "project_versions_reason_valid"`);
    await queryRunner.query(
      `ALTER TABLE "project_versions" ADD CONSTRAINT "project_versions_reason_valid" CHECK (reason IN ('create', 'save', 'restore', 'restyle'))`,
    );
  }
}
