import { MigrationInterface, QueryRunner } from 'typeorm';

export class Baseline1794412150604 implements MigrationInterface {
  name = 'Baseline1794412150604';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "merchants" ("id" uuid NOT NULL DEFAULT uuidv7(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "name" text NOT NULL, "slug" text NOT NULL, CONSTRAINT "merchants_slug_format" CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'), CONSTRAINT "merchants_name_not_blank" CHECK (length(btrim(name)) > 0), CONSTRAINT "PK_4fd312ef25f8e05ad47bfe7ed25" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "merchants_slug_key" ON "merchants"  ("slug") `);
    await queryRunner.query(
      `CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuidv7(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "merchant_id" uuid NOT NULL, "email" text NOT NULL, "password_hash" text NOT NULL, "display_name" text NOT NULL, "role" text NOT NULL DEFAULT 'owner', CONSTRAINT "users_role_valid" CHECK (role IN ('owner', 'editor')), CONSTRAINT "users_email_lowercase" CHECK (email = lower(email) AND position('@' in email) > 1), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "users_merchant_id_idx" ON "users"  ("merchant_id") `);
    await queryRunner.query(`CREATE UNIQUE INDEX "users_email_key" ON "users"  ("email") `);
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "users_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "users_merchant_id_fkey"`);
    await queryRunner.query(`DROP INDEX "public"."users_email_key"`);
    await queryRunner.query(`DROP INDEX "public"."users_merchant_id_idx"`);
    await queryRunner.query(`DROP TABLE "users"`);
    await queryRunner.query(`DROP INDEX "public"."merchants_slug_key"`);
    await queryRunner.query(`DROP TABLE "merchants"`);
  }
}
