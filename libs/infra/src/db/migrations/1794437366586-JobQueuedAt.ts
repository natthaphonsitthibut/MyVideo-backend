import { MigrationInterface, QueryRunner } from 'typeorm';

export class JobQueuedAt1794437366586 implements MigrationInterface {
  name = 'JobQueuedAt1794437366586';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "jobs" ADD "queued_at" TIMESTAMP WITH TIME ZONE`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "queued_at"`);
  }
}
