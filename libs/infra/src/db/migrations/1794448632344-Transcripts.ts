import { MigrationInterface, QueryRunner } from 'typeorm';

export class Transcripts1794448632344 implements MigrationInterface {
  name = 'Transcripts1794448632344';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "transcripts" ("id" uuid NOT NULL DEFAULT uuidv7(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "merchant_id" uuid NOT NULL, "source_id" uuid NOT NULL, "audio_sha256" text NOT NULL, "model" text NOT NULL, "engine" text NOT NULL, "recipe_version" integer NOT NULL, "status" text NOT NULL DEFAULT 'running', "duration_ms" integer NOT NULL, "chunk_count" integer NOT NULL DEFAULT '0', "language" text, "storage_key" text, "error" text, CONSTRAINT "transcripts_chunk_count_valid" CHECK (chunk_count >= 0), CONSTRAINT "transcripts_status_valid" CHECK (status IN ('running', 'ready', 'failed')), CONSTRAINT "PK_40c75f89c1fc953cd33e702247d" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "transcripts_merchant_id_idx" ON "transcripts"  ("merchant_id") `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "transcripts_cache_key" ON "transcripts"  ("source_id", "audio_sha256", "model", "recipe_version") `,
    );
    await queryRunner.query(
      `CREATE TABLE "transcript_chunks" ("id" uuid NOT NULL DEFAULT uuidv7(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "merchant_id" uuid NOT NULL, "transcript_id" uuid NOT NULL, "chunk_index" integer NOT NULL, "start_ms" integer NOT NULL, "end_ms" integer NOT NULL, "status" text NOT NULL DEFAULT 'pending', "result" jsonb, CONSTRAINT "transcript_chunks_span_valid" CHECK (start_ms >= 0 AND end_ms > start_ms), CONSTRAINT "transcript_chunks_status_valid" CHECK (status IN ('pending', 'done')), CONSTRAINT "PK_910890b500573d8594ef2ca8d4f" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "transcript_chunks_merchant_id_idx" ON "transcript_chunks"  ("merchant_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "transcript_chunks_transcript_index_key" ON "transcript_chunks"  ("transcript_id", "chunk_index") `,
    );
    await queryRunner.query(
      `CREATE TABLE "transcript_segments" ("id" uuid NOT NULL DEFAULT uuidv7(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "merchant_id" uuid NOT NULL, "transcript_id" uuid NOT NULL, "seq" integer NOT NULL, "start_ms" integer NOT NULL, "end_ms" integer NOT NULL, "text" text NOT NULL, "words" jsonb NOT NULL DEFAULT '[]', "avg_logprob" real, "no_speech_prob" real, CONSTRAINT "transcript_segments_span_valid" CHECK (start_ms >= 0 AND end_ms >= start_ms), CONSTRAINT "PK_34cfd4b54a9857af7dfa443f3ed" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "transcript_segments_merchant_id_idx" ON "transcript_segments"  ("merchant_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "transcript_segments_transcript_seq_key" ON "transcript_segments"  ("transcript_id", "seq") `,
    );
    await queryRunner.query(
      `ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "video_sources"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "transcript_chunks" ADD CONSTRAINT "transcript_chunks_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "transcript_chunks" ADD CONSTRAINT "transcript_chunks_transcript_id_fkey" FOREIGN KEY ("transcript_id") REFERENCES "transcripts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_transcript_id_fkey" FOREIGN KEY ("transcript_id") REFERENCES "transcripts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "transcript_segments" DROP CONSTRAINT "transcript_segments_transcript_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transcript_segments" DROP CONSTRAINT "transcript_segments_merchant_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transcript_chunks" DROP CONSTRAINT "transcript_chunks_transcript_id_fkey"`,
    );
    await queryRunner.query(
      `ALTER TABLE "transcript_chunks" DROP CONSTRAINT "transcript_chunks_merchant_id_fkey"`,
    );
    await queryRunner.query(`ALTER TABLE "transcripts" DROP CONSTRAINT "transcripts_source_id_fkey"`);
    await queryRunner.query(`ALTER TABLE "transcripts" DROP CONSTRAINT "transcripts_merchant_id_fkey"`);
    await queryRunner.query(`DROP INDEX "public"."transcript_segments_transcript_seq_key"`);
    await queryRunner.query(`DROP INDEX "public"."transcript_segments_merchant_id_idx"`);
    await queryRunner.query(`DROP TABLE "transcript_segments"`);
    await queryRunner.query(`DROP INDEX "public"."transcript_chunks_transcript_index_key"`);
    await queryRunner.query(`DROP INDEX "public"."transcript_chunks_merchant_id_idx"`);
    await queryRunner.query(`DROP TABLE "transcript_chunks"`);
    await queryRunner.query(`DROP INDEX "public"."transcripts_cache_key"`);
    await queryRunner.query(`DROP INDEX "public"."transcripts_merchant_id_idx"`);
    await queryRunner.query(`DROP TABLE "transcripts"`);
  }
}
