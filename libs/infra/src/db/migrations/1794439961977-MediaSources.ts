import { MigrationInterface, QueryRunner } from 'typeorm';

export class MediaSources1794439961977 implements MigrationInterface {
  name = 'MediaSources1794439961977';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "video_sources" ("id" uuid NOT NULL, "merchant_id" uuid NOT NULL, "upload_id" text NOT NULL, "title" text NOT NULL, "original_filename" text NOT NULL, "status" text NOT NULL DEFAULT 'processing', "size_bytes" bigint NOT NULL, "sha256" text NOT NULL, "probe" jsonb, "failure_reason" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "video_sources_title_not_blank" CHECK (length(btrim(title)) > 0), CONSTRAINT "video_sources_size_valid" CHECK (size_bytes > 0), CONSTRAINT "video_sources_status_valid" CHECK (status IN ('processing', 'ready', 'failed')), CONSTRAINT "PK_2b4ff25794018ffbe9afdd25e95" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "video_sources_merchant_created_idx" ON "video_sources"  ("merchant_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "video_sources_merchant_upload_key" ON "video_sources"  ("merchant_id", "upload_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "media_assets" ("id" uuid NOT NULL DEFAULT uuidv7(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "merchant_id" uuid NOT NULL, "source_id" uuid NOT NULL, "kind" text NOT NULL, "recipe_version" integer NOT NULL DEFAULT '1', "storage_key" text NOT NULL, "size_bytes" bigint NOT NULL, "sha256" text NOT NULL, "content_type" text NOT NULL, "meta" jsonb NOT NULL DEFAULT '{}', CONSTRAINT "media_assets_recipe_valid" CHECK (recipe_version >= 1), CONSTRAINT "media_assets_kind_valid" CHECK (kind IN ('original', 'proxy', 'audio', 'peaks', 'sprites')), CONSTRAINT "PK_ca47e9f67a5e5d8af1e75d66ee6" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "media_assets_merchant_id_idx" ON "media_assets"  ("merchant_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "media_assets_storage_key_key" ON "media_assets"  ("storage_key") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "media_assets_source_kind_recipe_key" ON "media_assets"  ("source_id", "kind", "recipe_version") `,
    );
    await queryRunner.query(
      `ALTER TABLE "video_sources" ADD CONSTRAINT "video_sources_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "video_sources"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "media_assets" DROP CONSTRAINT "media_assets_source_id_fkey"`);
    await queryRunner.query(`ALTER TABLE "media_assets" DROP CONSTRAINT "media_assets_merchant_id_fkey"`);
    await queryRunner.query(`ALTER TABLE "video_sources" DROP CONSTRAINT "video_sources_merchant_id_fkey"`);
    await queryRunner.query(`DROP INDEX "public"."media_assets_source_kind_recipe_key"`);
    await queryRunner.query(`DROP INDEX "public"."media_assets_storage_key_key"`);
    await queryRunner.query(`DROP INDEX "public"."media_assets_merchant_id_idx"`);
    await queryRunner.query(`DROP TABLE "media_assets"`);
    await queryRunner.query(`DROP INDEX "public"."video_sources_merchant_upload_key"`);
    await queryRunner.query(`DROP INDEX "public"."video_sources_merchant_created_idx"`);
    await queryRunner.query(`DROP TABLE "video_sources"`);
  }
}
