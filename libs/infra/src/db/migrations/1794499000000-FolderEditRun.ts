import type { MigrationInterface, QueryRunner } from 'typeorm';

/** `folder_edit` run kind: one project folder edit that starts the per-source workflows in order (E12-F05). */
export class FolderEditRun1794499000000 implements MigrationInterface {
  name = 'FolderEditRun1794499000000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "workflow_runs" DROP CONSTRAINT "workflow_runs_kind_valid"`);
    await q.query(
      `ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_kind_valid" CHECK (kind IN ('ingest', 'transcribe', 'live_to_clips', 'restyle_clip', 'build_clips', 'review_to_video', 'folder_edit', 'render', 'purge', 'system_test'))`,
    );
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`DELETE FROM "workflow_runs" WHERE kind = 'folder_edit'`);
    await q.query(`ALTER TABLE "workflow_runs" DROP CONSTRAINT "workflow_runs_kind_valid"`);
    await q.query(
      `ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_kind_valid" CHECK (kind IN ('ingest', 'transcribe', 'live_to_clips', 'restyle_clip', 'build_clips', 'review_to_video', 'render', 'purge', 'system_test'))`,
    );
  }
}
