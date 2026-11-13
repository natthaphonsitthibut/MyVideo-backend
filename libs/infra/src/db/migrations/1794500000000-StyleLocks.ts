import type { MigrationInterface, QueryRunner } from 'typeorm';
export class StyleLocks1794500000000 implements MigrationInterface {
  name = 'StyleLocks1794500000000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE merchant_style_locks(id uuid PRIMARY KEY DEFAULT uuidv7(),merchant_id uuid NOT NULL, snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),CONSTRAINT merchant_style_locks_merchant_fkey FOREIGN KEY(merchant_id) REFERENCES merchants(id) ON DELETE CASCADE)`,
    );
    await q.query(
      `CREATE UNIQUE INDEX merchant_style_locks_merchant_key ON merchant_style_locks(merchant_id)`,
    );
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE merchant_style_locks`);
  }
}
