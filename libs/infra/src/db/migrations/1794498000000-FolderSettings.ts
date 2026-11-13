import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Project folder settings (ratio, goal, length, merchant-typed product name/price), validated by the API. */
export class FolderSettings1794498000000 implements MigrationInterface {
  name = 'FolderSettings1794498000000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE project_folders ADD COLUMN settings jsonb NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(settings) = 'object')`,
    );
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE project_folders DROP COLUMN settings');
  }
}
