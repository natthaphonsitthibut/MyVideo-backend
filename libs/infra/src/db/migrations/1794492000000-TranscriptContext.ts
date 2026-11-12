import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Whole-video AI context on transcripts; empty-text AI edits = continuations of a merged glossary term. */
export class TranscriptContext1794492000000 implements MigrationInterface {
  name = 'TranscriptContext1794492000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "transcripts" ADD "ai_context" jsonb`);
    await queryRunner.query(`ALTER TABLE "transcript_edits" DROP CONSTRAINT "transcript_edits_text_valid"`);
    await queryRunner.query(
      `ALTER TABLE "transcript_edits" ADD CONSTRAINT "transcript_edits_text_valid" CHECK ((origin = 'ai' AND text = '') OR (length(btrim(text)) > 0 AND length(text) <= 200))`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // a merged span cannot exist under the old rule: drop the whole span (the words read as heard again)
    await queryRunner.query(
      `DELETE FROM "transcript_edits" e WHERE e.origin = 'ai' AND (e.text = '' OR EXISTS (
         SELECT 1 FROM "transcript_edits" c WHERE c.transcript_id = e.transcript_id AND c.seq = e.seq
           AND c.word_index = e.word_index + 1 AND c.origin = 'ai' AND c.text = ''))`,
    );
    await queryRunner.query(`ALTER TABLE "transcript_edits" DROP CONSTRAINT "transcript_edits_text_valid"`);
    await queryRunner.query(
      `ALTER TABLE "transcript_edits" ADD CONSTRAINT "transcript_edits_text_valid" CHECK (length(btrim(text)) > 0 AND length(text) <= 200)`,
    );
    await queryRunner.query(`ALTER TABLE "transcripts" DROP COLUMN "ai_context"`);
  }
}
