import type { MigrationInterface, QueryRunner } from 'typeorm';

/** The merchant's check of an AI correction (review queue). */
export class TranscriptEditReview1794493000000 implements MigrationInterface {
  name = 'TranscriptEditReview1794493000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "transcript_edits" ADD "reviewed_at" TIMESTAMP WITH TIME ZONE`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "transcript_edits" DROP COLUMN "reviewed_at"`);
  }
}
