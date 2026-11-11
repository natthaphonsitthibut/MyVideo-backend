import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { QUEUES } from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { freshTestDb } from '../../../test/test-db.js';
import { testEnv } from '../../../test/test-env.js';
import { JobEntity } from '../src/db/entities/job.entity.js';
import { seedMerchant } from '../src/db/seed.js';
import { createRunInTransaction, enqueueInTransaction } from '../src/jobs/job-store.js';
import { QueueSet } from '../src/jobs/queues.js';

// Real processes: the built worker app (`pnpm build` runs before tests in CI and in scripts/dev.sh).
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORKER = `${ROOT}apps/worker/dist/main.js`;
const env = testEnv();
let ds: DataSource;
let merchantId: string;
let prefix = '';
const procs: ChildProcess[] = [];

function startWorker(): ChildProcess {
  const p = spawn('node', [WORKER], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: env.DATABASE_URL,
      REDIS_URL: env.REDIS_URL,
      SESSION_SECRET: 'test-session-secret',
      QUEUE_PREFIX: prefix,
      DISPATCH_POLL_MS: '50',
      JOB_HEARTBEAT_MS: '200',
      JOB_STALE_AFTER_MS: '1500',
      JOB_LOST_AFTER_MS: '0',
    },
    stdio: 'ignore',
  });
  procs.push(p);
  return p;
}

const kill9 = (p: ChildProcess) =>
  new Promise<void>((resolve) => {
    p.once('exit', () => resolve());
    p.kill('SIGKILL');
  });

async function sleepJob(ms: number) {
  return ds.transaction(async (em) => {
    const run = await createRunInTransaction(em, { merchantId, kind: 'system_test' });
    return (
      await enqueueInTransaction(em, {
        merchantId,
        workflowRunId: run.id,
        type: 'system.sleep',
        queue: 'media',
        idempotencyKey: randomUUID(),
        payload: { ms, steps: 10 },
      })
    ).job;
  });
}
const reload = (id: string) => ds.getRepository(JobEntity).findOneByOrFail({ id });
const attemptLog = async (id: string) =>
  (
    (await ds.query('SELECT attempt_no, status FROM job_attempts WHERE job_id = $1 ORDER BY attempt_no', [
      id,
    ])) as { attempt_no: number; status: string }[]
  ).map((a) => `${a.attempt_no}:${a.status}`);

beforeAll(async () => {
  if (!existsSync(WORKER)) throw new Error('build first: pnpm build');
  ds = await freshTestDb();
  merchantId = (
    await seedMerchant(ds, {
      merchantName: 'A',
      merchantSlug: 'shop-a',
      email: 'a@a.local',
      password: 'password-a',
      displayName: 'A',
    })
  ).merchant.id;
});
afterEach(async () => {
  for (const p of procs.splice(0)) if (p.exitCode === null && p.signalCode === null) await kill9(p);
  const qs = new QueueSet({ redisUrl: env.REDIS_URL, prefix });
  for (const q of QUEUES) await qs.get(q).obliterate({ force: true });
  await qs.close();
  await ds.query('TRUNCATE workflow_runs CASCADE');
});
afterAll(async () => ds.destroy());

describe('crash recovery with real processes', { timeout: 60_000 }, () => {
  it('a worker killed mid-job: after restart the job finishes exactly once', async () => {
    prefix = `test-${randomUUID().slice(0, 8)}`;
    const job = await sleepJob(3000);
    const w1 = startWorker();
    await expect
      .poll(async () => (await reload(job.id)).progress, { timeout: 15_000, interval: 50 })
      .toBeGreaterThan(0.1);
    await kill9(w1);
    expect((await reload(job.id)).status).toBe('running'); // lease still held by the dead worker
    startWorker();
    await expect
      .poll(async () => (await reload(job.id)).status, { timeout: 20_000, interval: 100 })
      .toBe('succeeded');
    expect(await attemptLog(job.id)).toEqual(['1:failed', '2:succeeded']);
    expect((await reload(job.id)).result).toEqual({ sleptMs: 3000 });
  });

  it('a dispatcher killed between commit and enqueue: the job still runs exactly once', async () => {
    prefix = `test-${randomUUID().slice(0, 8)}`;
    const job = await sleepJob(200);
    const out = await new Promise<string>((resolve) => {
      const p = spawn('node', [`${ROOT}test/fixtures/crash-dispatcher.mjs`], {
        cwd: ROOT,
        env: {
          ...process.env,
          DATABASE_URL: env.DATABASE_URL,
          REDIS_URL: env.REDIS_URL,
          QUEUE_PREFIX: prefix,
        },
      });
      let s = '';
      p.stdout?.on('data', (d) => {
        s += d;
      });
      p.on('exit', (_code, signal) => resolve(`${s.trim()} / ${signal}`));
    });
    expect(out).toBe('claimed 1 / SIGKILL');
    expect((await reload(job.id)).status).toBe('queued'); // committed, never published
    startWorker();
    await expect
      .poll(async () => (await reload(job.id)).status, { timeout: 20_000, interval: 100 })
      .toBe('succeeded');
    expect(await attemptLog(job.id)).toEqual(['1:succeeded']);
  });
});
