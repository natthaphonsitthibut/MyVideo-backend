import type { MigrationInterface, QueryRunner } from 'typeorm';

/** The merchant's brand kit (E08-F08): one per merchant. */
export class BrandKits1794494000000 implements MigrationInterface {
  name = 'BrandKits1794494000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "brand_kits" (
      "id" uuid NOT NULL DEFAULT uuidv7(),
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "merchant_id" uuid NOT NULL,
      "primary_color" text NOT NULL,
      "accent_color" text NOT NULL,
      "text_color" text NOT NULL,
      "font" text NOT NULL,
      "default_cta" text NOT NULL,
      "logo_key" text,
      "logo_content_type" text,
      CONSTRAINT "brand_kits_colors_valid" CHECK (primary_color ~ '^#[0-9a-fA-F]{6}$' AND accent_color ~ '^#[0-9a-fA-F]{6}$' AND text_color ~ '^#[0-9a-fA-F]{6}$'),
      CONSTRAINT "brand_kits_cta_valid" CHECK (char_length(default_cta) BETWEEN 1 AND 40),
      CONSTRAINT "brand_kits_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE,
      CONSTRAINT "PK_brand_kits" PRIMARY KEY ("id")
    )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "brand_kits_merchant_id_key" ON "brand_kits" ("merchant_id")`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "brand_kits"`);
  }
}
