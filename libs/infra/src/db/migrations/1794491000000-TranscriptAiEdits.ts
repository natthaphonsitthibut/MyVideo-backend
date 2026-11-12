import type { MigrationInterface, QueryRunner } from 'typeorm';

export class TranscriptAiEdits1794491000000 implements MigrationInterface {
  name = 'TranscriptAiEdits1794491000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE transcript_edits ADD COLUMN origin text NOT NULL DEFAULT 'user'`);
    await queryRunner.query(
      `ALTER TABLE transcript_edits ADD CONSTRAINT transcript_edits_origin_valid CHECK (origin IN ('user', 'ai'))`,
    );
    await queryRunner.query(
      `ALTER TABLE transcripts ADD COLUMN ai_fix_completed boolean NOT NULL DEFAULT false`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE transcripts DROP COLUMN ai_fix_completed`);
    await queryRunner.query(`ALTER TABLE transcript_edits DROP CONSTRAINT transcript_edits_origin_valid`);
    await queryRunner.query(`ALTER TABLE transcript_edits DROP COLUMN origin`);
  }
}
