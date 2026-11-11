import { MigrationInterface, QueryRunner } from 'typeorm';

export class JobEvents1794437958981 implements MigrationInterface {
  name = 'JobEvents1794437958981';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "job_events" ("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL, "merchant_id" uuid NOT NULL, "workflow_run_id" uuid NOT NULL, "job_id" uuid, "kind" text NOT NULL, "status" text NOT NULL, "progress" real, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "job_events_kind_valid" CHECK (kind IN ('job', 'run')), CONSTRAINT "PK_77f0d06e95eed355f7a38f6093b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "job_events_merchant_id_idx" ON "job_events"  ("merchant_id") `);
    await queryRunner.query(
      `CREATE INDEX "job_events_run_id_idx" ON "job_events"  ("workflow_run_id", "id") `,
    );
    // Change feed + NOTIFY for live progress (hand-written: TypeORM does not model triggers).
    await queryRunner.query(`
      CREATE FUNCTION job_events_from_jobs() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE eid bigint;
      BEGIN
        IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status OR NEW.progress IS DISTINCT FROM OLD.progress
           OR NEW.cancel_requested IS DISTINCT FROM OLD.cancel_requested THEN
          INSERT INTO job_events (merchant_id, workflow_run_id, job_id, kind, status, progress)
          VALUES (NEW.merchant_id, NEW.workflow_run_id, NEW.id, 'job', NEW.status, NEW.progress)
          RETURNING id INTO eid;
          PERFORM pg_notify('job_events', json_build_object('id', eid, 'runId', NEW.workflow_run_id,
            'merchantId', NEW.merchant_id)::text);
        END IF;
        RETURN NEW;
      END $$`);
    await queryRunner.query(`
      CREATE FUNCTION job_events_from_runs() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE eid bigint;
      BEGIN
        IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
          INSERT INTO job_events (merchant_id, workflow_run_id, job_id, kind, status, progress)
          VALUES (NEW.merchant_id, NEW.id, NULL, 'run', NEW.status, NULL)
          RETURNING id INTO eid;
          PERFORM pg_notify('job_events', json_build_object('id', eid, 'runId', NEW.id,
            'merchantId', NEW.merchant_id)::text);
        END IF;
        RETURN NEW;
      END $$`);
    await queryRunner.query(
      `CREATE TRIGGER jobs_change_feed AFTER INSERT OR UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION job_events_from_jobs()`,
    );
    await queryRunner.query(
      `CREATE TRIGGER workflow_runs_change_feed AFTER INSERT OR UPDATE ON workflow_runs FOR EACH ROW EXECUTE FUNCTION job_events_from_runs()`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER workflow_runs_change_feed ON workflow_runs`);
    await queryRunner.query(`DROP TRIGGER jobs_change_feed ON jobs`);
    await queryRunner.query(`DROP FUNCTION job_events_from_runs()`);
    await queryRunner.query(`DROP FUNCTION job_events_from_jobs()`);
    await queryRunner.query(`DROP INDEX "public"."job_events_run_id_idx"`);
    await queryRunner.query(`DROP INDEX "public"."job_events_merchant_id_idx"`);
    await queryRunner.query(`DROP TABLE "job_events"`);
  }
}
