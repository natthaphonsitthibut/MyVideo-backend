import { MigrationInterface, QueryRunner } from 'typeorm';

/** `purge` runs: files of a source/project the merchant deleted are removed by a retry-safe job (E12-F02). */
export class PurgeRun1794496000000 implements MigrationInterface {
  name = 'PurgeRun1794496000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "workflow_runs" DROP CONSTRAINT "workflow_runs_kind_valid"`);
    await queryRunner.query(
      `ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_kind_valid" CHECK (kind IN ('ingest', 'transcribe', 'live_to_clips', 'restyle_clip', 'build_clips', 'review_to_video', 'render', 'purge', 'system_test'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "workflow_runs" WHERE kind = 'purge'`);
    await queryRunner.query(`ALTER TABLE "workflow_runs" DROP CONSTRAINT "workflow_runs_kind_valid"`);
    await queryRunner.query(
      `ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_kind_valid" CHECK (kind IN ('ingest', 'transcribe', 'live_to_clips', 'restyle_clip', 'build_clips', 'review_to_video', 'render', 'system_test'))`,
    );
  }
}
