import { MigrationInterface, QueryRunner } from 'typeorm';

/** Restyle of AI clips: stored build input, `restyle_clip` runs, `restyle` project versions. */
export class ClipRestyle1794480000000 implements MigrationInterface {
  name = 'ClipRestyle1794480000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "clip_suggestions" ADD "build_input" jsonb`);
    await queryRunner.query(`ALTER TABLE "workflow_runs" DROP CONSTRAINT "workflow_runs_kind_valid"`);
    await queryRunner.query(
      `ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_kind_valid" CHECK (kind IN ('ingest', 'transcribe', 'live_to_clips', 'restyle_clip', 'review_to_video', 'render', 'system_test'))`,
    );
    await queryRunner.query(`ALTER TABLE "project_versions" DROP CONSTRAINT "project_versions_reason_valid"`);
    await queryRunner.query(
      `ALTER TABLE "project_versions" ADD CONSTRAINT "project_versions_reason_valid" CHECK (reason IN ('create', 'save', 'restore', 'restyle'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // keep the versions (they are the merchant's history); they just read as ordinary saves again
    await queryRunner.query(`UPDATE "project_versions" SET reason = 'save' WHERE reason = 'restyle'`);
    await queryRunner.query(`ALTER TABLE "project_versions" DROP CONSTRAINT "project_versions_reason_valid"`);
    await queryRunner.query(
      `ALTER TABLE "project_versions" ADD CONSTRAINT "project_versions_reason_valid" CHECK (reason IN ('create', 'save', 'restore'))`,
    );
    await queryRunner.query(`DELETE FROM "workflow_runs" WHERE kind = 'restyle_clip'`);
    await queryRunner.query(`ALTER TABLE "workflow_runs" DROP CONSTRAINT "workflow_runs_kind_valid"`);
    await queryRunner.query(
      `ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_kind_valid" CHECK (kind IN ('ingest', 'transcribe', 'live_to_clips', 'review_to_video', 'render', 'system_test'))`,
    );
    await queryRunner.query(`ALTER TABLE "clip_suggestions" DROP COLUMN "build_input"`);
  }
}
