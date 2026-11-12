import { MigrationInterface, QueryRunner } from 'typeorm';

export class TranscriptEdits1794452328318 implements MigrationInterface {
  name = 'TranscriptEdits1794452328318';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "transcript_edits" ("id" uuid NOT NULL DEFAULT uuidv7(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "merchant_id" uuid NOT NULL, "transcript_id" uuid NOT NULL, "seq" integer NOT NULL, "word_index" integer NOT NULL, "text" text NOT NULL, CONSTRAINT "transcript_edits_position_valid" CHECK (seq >= 0 AND word_index >= 0), CONSTRAINT "transcript_edits_text_valid" CHECK (length(btrim(text)) > 0 AND length(text) <= 200), CONSTRAINT "PK_a2e1d483a177c2f5ef1cdaa2047" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "transcript_edits_merchant_id_idx" ON "transcript_edits"  ("merchant_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "transcript_edits_word_key" ON "transcript_edits"  ("transcript_id", "seq", "word_index") `,
    );
    await queryRunner.query(
      `ALTER TABLE "transcript_edits" ADD CONSTRAINT "transcript_edits_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "transcript_edits" ADD CONSTRAINT "transcript_edits_transcript_id_fkey" FOREIGN KEY ("transcript_id") REFERENCES "transcripts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "transcript_edits" DROP CONSTRAINT "transcript_edits_transcript_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transcript_edits" DROP CONSTRAINT "transcript_edits_merchant_id_fkey"`,
    );
    await queryRunner.query(`DROP INDEX "public"."transcript_edits_word_key"`);
    await queryRunner.query(`DROP INDEX "public"."transcript_edits_merchant_id_idx"`);
    await queryRunner.query(`DROP TABLE "transcript_edits"`);
  }
}
