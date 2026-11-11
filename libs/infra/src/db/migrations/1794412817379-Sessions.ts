import { MigrationInterface, QueryRunner } from 'typeorm';

export class Sessions1794412817379 implements MigrationInterface {
  name = 'Sessions1794412817379';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "sessions" ("id" uuid NOT NULL DEFAULT uuidv7(), "token_hash" bytea NOT NULL, "user_id" uuid NOT NULL, "merchant_id" uuid NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_3238ef96f18b355b671619111bc" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"  ("token_hash") `);
    await queryRunner.query(`CREATE INDEX "sessions_user_id_idx" ON "sessions"  ("user_id") `);
    await queryRunner.query(`CREATE INDEX "sessions_merchant_id_idx" ON "sessions"  ("merchant_id") `);
    await queryRunner.query(`CREATE INDEX "sessions_expires_at_idx" ON "sessions"  ("expires_at") `);
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sessions" ADD CONSTRAINT "sessions_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "sessions" DROP CONSTRAINT "sessions_merchant_id_fkey"`);
    await queryRunner.query(`ALTER TABLE "sessions" DROP CONSTRAINT "sessions_user_id_fkey"`);
    await queryRunner.query(`DROP INDEX "public"."sessions_expires_at_idx"`);
    await queryRunner.query(`DROP INDEX "public"."sessions_merchant_id_idx"`);
    await queryRunner.query(`DROP INDEX "public"."sessions_user_id_idx"`);
    await queryRunner.query(`DROP INDEX "public"."sessions_token_hash_key"`);
    await queryRunner.query(`DROP TABLE "sessions"`);
  }
}
