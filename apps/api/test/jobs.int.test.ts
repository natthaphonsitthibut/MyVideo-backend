import { randomUUID } from 'node:crypto';
import { createRunInTransaction, enqueueInTransaction, seedMerchant } from '@myvideo/infra';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshTestDb } from '../../../test/test-db.js';
import { testEnv } from '../../../test/test-env.js';
import { createApp } from '../src/app.js';
import { loginCookie } from './helpers.js';

const A = {
  merchantName: 'A',
  merchantSlug: 'shop-a',
  email: 'a@a.local',
  password: 'password-a',
  displayName: 'A',
};
const B = {
  merchantName: 'B',
  merchantSlug: 'shop-b',
  email: 'b@b.local',
  password: 'password-b',
  displayName: 'B',
};

describe('POST /jobs/:id/retry (real Postgres)', () => {
  let ds: DataSource;
  let app: INestApplication;
  let cookieA: string;
  let cookieB: string;
  let merchantA: string;

  const jobIn = async (status: string) =>
    ds.transaction(async (em) => {
      const run = await createRunInTransaction(em, { merchantId: merchantA, kind: 'system_test' });
      const { job } = await enqueueInTransaction(em, {
        merchantId: merchantA,
        workflowRunId: run.id,
        type: 'system.noop',
        queue: 'media',
        idempotencyKey: randomUUID(),
      });
      await em.query(
        `UPDATE jobs SET status = $2, attempts = 3, error = '{"message":"boom"}' WHERE id = $1`,
        [job.id, status],
      );
      await em.query(`UPDATE workflow_runs SET status = 'failed' WHERE id = $1`, [run.id]);
      return job;
    });

  beforeAll(async () => {
    ds = await freshTestDb();
    merchantA = (await seedMerchant(ds, A)).merchant.id;
    await seedMerchant(ds, B);
    app = await createApp(testEnv());
    await app.init();
    cookieA = await loginCookie(app, A.email, A.password);
    cookieB = await loginCookie(app, B.email, B.password);
  });
  afterAll(async () => {
    await app.close();
    await ds.destroy();
  });

  it('puts a dead job back to pending with a fresh budget and reopens the run', async () => {
    const job = await jobIn('dead');
    const res = await request(app.getHttpServer()).post(`/jobs/${job.id}/retry`).set('Cookie', cookieA);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: job.id,
      status: 'pending',
      attempts: 3,
      maxAttempts: 6,
      error: { message: 'boom' },
    });
    const run: { status: string }[] = await ds.query('SELECT status FROM workflow_runs WHERE id = $1', [
      job.workflowRunId,
    ]);
    expect(run[0]?.status).toBe('pending');
  });

  it('returns 404 for another merchant and 409 for a job that is not dead', async () => {
    const dead = await jobIn('dead');
    expect(
      (await request(app.getHttpServer()).post(`/jobs/${dead.id}/retry`).set('Cookie', cookieB)).status,
    ).toBe(404);
    const running = await jobIn('running');
    const res = await request(app.getHttpServer()).post(`/jobs/${running.id}/retry`).set('Cookie', cookieA);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('conflict');
  });

  it('validates the id', async () => {
    const res = await request(app.getHttpServer()).post('/jobs/not-a-uuid/retry').set('Cookie', cookieA);
    expect(res.status).toBe(400);
  });
});

describe('POST /jobs/:id/cancel (real Postgres)', () => {
  let ds: DataSource;
  let app: INestApplication;
  let cookieA: string;
  let cookieB: string;
  let merchantA: string;
  const make = async (status: string) =>
    ds.transaction(async (em) => {
      const run = await createRunInTransaction(em, { merchantId: merchantA, kind: 'system_test' });
      const { job } = await enqueueInTransaction(em, {
        merchantId: merchantA,
        workflowRunId: run.id,
        type: 'system.noop',
        queue: 'media',
        idempotencyKey: randomUUID(),
      });
      await em.query('UPDATE jobs SET status = $2 WHERE id = $1', [job.id, status]);
      return job;
    });
  beforeAll(async () => {
    ds = await freshTestDb();
    merchantA = (await seedMerchant(ds, A)).merchant.id;
    await seedMerchant(ds, B);
    app = await createApp(testEnv());
    await app.init();
    cookieA = await loginCookie(app, A.email, A.password);
    cookieB = await loginCookie(app, B.email, B.password);
  });
  afterAll(async () => {
    await app.close();
    await ds.destroy();
  });

  it('cancels a waiting job immediately and the run follows', async () => {
    const job = await make('pending');
    const res = await request(app.getHttpServer()).post(`/jobs/${job.id}/cancel`).set('Cookie', cookieA);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'cancelled', cancelRequested: true });
    const run: { status: string }[] = await ds.query('SELECT status FROM workflow_runs WHERE id = $1', [
      job.workflowRunId,
    ]);
    expect(run[0]?.status).toBe('cancelled');
  });

  it('only flags a running job (the worker stops it)', async () => {
    const job = await make('running');
    const res = await request(app.getHttpServer()).post(`/jobs/${job.id}/cancel`).set('Cookie', cookieA);
    expect(res.body).toMatchObject({ status: 'running', cancelRequested: true });
  });

  it('404 for another merchant, 409 when already finished', async () => {
    const job = await make('pending');
    expect(
      (await request(app.getHttpServer()).post(`/jobs/${job.id}/cancel`).set('Cookie', cookieB)).status,
    ).toBe(404);
    const done = await make('succeeded');
    expect(
      (await request(app.getHttpServer()).post(`/jobs/${done.id}/cancel`).set('Cookie', cookieA)).status,
    ).toBe(409);
  });
});
