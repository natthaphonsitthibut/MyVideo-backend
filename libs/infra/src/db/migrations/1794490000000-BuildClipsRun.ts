import { MigrationInterface, QueryRunner } from 'typeorm';

/** `build_clips` runs: the merchant picked a recommended style, the analysed clips are edited with it. */
export class BuildClipsRun1794490000000 implements MigrationInterface {
  name = 'BuildClipsRun1794490000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "workflow_runs" DROP CONSTRAINT "workflow_runs_kind_valid"`);
    await queryRunner.query(
      `ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_kind_valid" CHECK (kind IN ('ingest', 'transcribe', 'live_to_clips', 'restyle_clip', 'build_clips', 'review_to_video', 'render', 'system_test'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "workflow_runs" WHERE kind = 'build_clips'`);
    await queryRunner.query(`ALTER TABLE "workflow_runs" DROP CONSTRAINT "workflow_runs_kind_valid"`);
    await queryRunner.query(
      `ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_kind_valid" CHECK (kind IN ('ingest', 'transcribe', 'live_to_clips', 'restyle_clip', 'review_to_video', 'render', 'system_test'))`,
    );
  }
}
