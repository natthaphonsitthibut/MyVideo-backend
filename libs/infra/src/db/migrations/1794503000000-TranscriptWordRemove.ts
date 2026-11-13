import type { MigrationInterface, QueryRunner } from 'typeorm';

/** An empty merchant edit removes the word from the transcript and captions (the ASR word stays). */
export class TranscriptWordRemove1794503000000 implements MigrationInterface {
  name = 'TranscriptWordRemove1794503000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE transcript_edits DROP CONSTRAINT transcript_edits_text_valid`);
    await queryRunner.query(
      `ALTER TABLE transcript_edits ADD CONSTRAINT transcript_edits_text_valid CHECK (text = '' OR (length(btrim(text)) > 0 AND length(text) <= 200))`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM transcript_edits WHERE origin = 'user' AND text = ''`);
    await queryRunner.query(`ALTER TABLE transcript_edits DROP CONSTRAINT transcript_edits_text_valid`);
    await queryRunner.query(
      `ALTER TABLE transcript_edits ADD CONSTRAINT transcript_edits_text_valid CHECK ((origin = 'ai' AND text = '') OR (length(btrim(text)) > 0 AND length(text) <= 200))`,
    );
  }
}
