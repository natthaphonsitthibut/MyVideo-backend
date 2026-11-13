import type { MigrationInterface, QueryRunner } from 'typeorm';
export class MerchantMusic1794501000000 implements MigrationInterface {
  name = 'MerchantMusic1794501000000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE merchant_music(id uuid PRIMARY KEY DEFAULT uuidv7(),merchant_id uuid NOT NULL,title text NOT NULL,storage_key text NOT NULL,sha256 text NOT NULL,size_bytes bigint NOT NULL,license text NOT NULL,content_type text NOT NULL,status text NOT NULL DEFAULT 'processing',duration_ms integer,analysis jsonb,error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),CONSTRAINT merchant_music_merchant_fkey FOREIGN KEY(merchant_id) REFERENCES merchants(id) ON DELETE CASCADE,CONSTRAINT merchant_music_status_valid CHECK(status IN ('processing','ready','failed')),CONSTRAINT merchant_music_size_valid CHECK(size_bytes>0),CONSTRAINT merchant_music_duration_valid CHECK(duration_ms IS NULL OR duration_ms>0))`,
    );
    await q.query('CREATE INDEX merchant_music_merchant_idx ON merchant_music(merchant_id)');
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE merchant_music');
  }
}
