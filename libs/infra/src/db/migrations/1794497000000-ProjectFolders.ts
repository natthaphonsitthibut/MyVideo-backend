import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ProjectFolders1794497000000 implements MigrationInterface {
  name = 'ProjectFolders1794497000000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE project_folders (
      id uuid PRIMARY KEY, merchant_id uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, merchant_id)
    )`);
    await q.query(
      'CREATE INDEX project_folders_merchant_updated_idx ON project_folders (merchant_id, updated_at DESC)',
    );
    await q.query(
      'ALTER TABLE video_sources ADD CONSTRAINT video_sources_id_merchant_key UNIQUE (id, merchant_id)',
    );
    await q.query(`CREATE TABLE project_folder_sources (
      id uuid PRIMARY KEY, merchant_id uuid NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      folder_id uuid NOT NULL, source_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (folder_id, source_id),
      FOREIGN KEY (folder_id, merchant_id) REFERENCES project_folders(id, merchant_id) ON DELETE CASCADE,
      FOREIGN KEY (source_id, merchant_id) REFERENCES video_sources(id, merchant_id) ON DELETE CASCADE
    )`);
    await q.query('CREATE INDEX project_folder_sources_merchant_idx ON project_folder_sources (merchant_id)');
    await q.query(
      'CREATE INDEX project_folder_sources_source_idx ON project_folder_sources (source_id, merchant_id)',
    );
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE project_folder_sources');
    await q.query('DROP TABLE project_folders');
    await q.query('ALTER TABLE video_sources DROP CONSTRAINT video_sources_id_merchant_key');
  }
}
