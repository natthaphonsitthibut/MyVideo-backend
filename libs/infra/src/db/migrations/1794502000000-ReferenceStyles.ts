import type { MigrationInterface, QueryRunner } from 'typeorm';
export class ReferenceStyles1794502000000 implements MigrationInterface {
  name = 'ReferenceStyles1794502000000';
  async up(q: QueryRunner) {
    await q.query(
      `CREATE TABLE reference_styles(id uuid PRIMARY KEY DEFAULT uuidv7(),merchant_id uuid NOT NULL,source_id uuid NOT NULL,title text NOT NULL,status text NOT NULL DEFAULT 'waiting',run_id uuid NOT NULL,grammar jsonb,snapshot jsonb,error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),CONSTRAINT reference_styles_merchant_fkey FOREIGN KEY(merchant_id) REFERENCES merchants(id) ON DELETE CASCADE,CONSTRAINT reference_styles_source_merchant_fkey FOREIGN KEY(source_id,merchant_id) REFERENCES video_sources(id,merchant_id) ON DELETE CASCADE,CONSTRAINT reference_styles_status_valid CHECK(status IN ('waiting','processing','ready','failed')))`,
    );
    await q.query('CREATE UNIQUE INDEX reference_styles_source_key ON reference_styles(source_id)');
    await q.query('CREATE INDEX reference_styles_merchant_idx ON reference_styles(merchant_id)');
  }
  async down(q: QueryRunner) {
    await q.query('DROP TABLE reference_styles');
  }
}
