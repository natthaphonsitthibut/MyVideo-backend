import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { QUEUES } from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { footageClip } from '../../../test/footage.js';
import { freshTestDb } from '../../../test/test-db.js';
import { testEnv } from '../../../test/test-env.js';
import { JobEntity } from '../src/db/entities/job.entity.js';
import { seedMerchant } from '../src/db/seed.js';
import { Dispatcher } from '../src/jobs/dispatcher.js';
import { HandlerRegistry } from '../src/jobs/handlers.js';
import { createRunInTransaction, enqueueInTransaction } from '../src/jobs/job-store.js';
import { QueueSet } from '../src/jobs/queues.js';
import { JobRunner } from '../src/jobs/runner.js';
import { QueueWorkers } from '../src/jobs/workers.js';
import { ffmpegProgressParser, runProcess, withTempDir } from '../src/process/run-process.js';

// Real footage when available (local dev); CI has none → ffmpeg test pattern, a pure plumbing input.
const REAL = footageClip('talkinghead-th-portrait.mp4');
const INPUT = REAL
  ? ['-re', '-i', REAL]
  : ['-re', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=60'];

const redisUrl = testEnv().REDIS_URL;
let ds: DataSource;
let merchantId: string;
let stack: { close: () => Promise<void> }[] = [];
let prefix = '';
const seen = new Map<string, { pid: number; dir: string }>();

const registry = new HandlerRegistry().register({
  type: 'test.transcode',
  queue: 'media',
  run: ({ job, signal, progress }) =>
    withTempDir('transcode', async (dir) => {
      const out = join(dir, 'out.mp4');
      await runProcess(
        'ffmpeg',
        [
          '-v',
          'error',
          '-y',
          ...INPUT,
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-c:a',
          'aac',
          '-progress',
          'pipe:1',
          out,
        ],
        {
          signal,
          onSpawn: (pid) => seen.set(job.id, { pid, dir }),
          onStdoutLine: ffmpegProgressParser((s) => void progress(Math.min(0.99, s / 60))),
        },
      );
      return { out };
    }),
});

function start() {
  prefix = `test-${randomUUID().slice(0, 8)}`;
  const qs = new QueueSet({ redisUrl, prefix });
  const workers = new QueueWorkers(
    { redisUrl, prefix, concurrency: { media: 1, ai: 1, render: 1 } },
    new JobRunner(ds, registry, { workerId: 'w-cancel', heartbeatMs: 100, progressThrottleMs: 50 }),
  );
  const d = new Dispatcher(ds, qs, { pollMs: 25 });
  workers.start(['media']);
  d.start();
  stack = [{ close: () => d.stop() }, workers, qs];
}

async function add(timeoutMs = 600_000) {
  return ds.transaction(async (em) => {
    const run = await createRunInTransaction(em, { merchantId, kind: 'system_test' });
    return (
      await enqueueInTransaction(em, {
        merchantId,
        workflowRunId: run.id,
        type: 'test.transcode',
        queue: 'media',
        idempotencyKey: randomUUID(),
        maxAttempts: 1,
        timeoutMs,
      })
    ).job;
  });
}

const reload = (id: string) => ds.getRepository(JobEntity).findOneByOrFail({ id });
const ffmpegAlive = async (pid: number) =>
  runProcess('pgrep', ['-g', String(pid)]).then(
    () => true,
    () => false,
  );

beforeAll(async () => {
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
  for (const s of stack) await s.close();
  stack = [];
  const q = new QueueSet({ redisUrl, prefix });
  for (const n of QUEUES) await q.get(n).obliterate({ force: true });
  await q.close();
});
afterAll(async () => ds.destroy());

describe(`cancel and timeout kill ffmpeg (${REAL ? 'real footage' : 'plumbing input'})`, () => {
  it('cancelling a running transcode kills ffmpeg and removes its temp files', async () => {
    start();
    const job = await add();
    await expect.poll(async () => (await reload(job.id)).progress, { timeout: 15_000 }).toBeGreaterThan(0);
    const { pid, dir } = seen.get(job.id) ?? { pid: 0, dir: '' };
    expect(await ffmpegAlive(pid)).toBe(true);
    expect(existsSync(dir)).toBe(true);
    await ds.query('UPDATE jobs SET cancel_requested = true WHERE id = $1', [job.id]);
    await expect.poll(async () => (await reload(job.id)).status, { timeout: 10_000 }).toBe('cancelled');
    expect(await ffmpegAlive(pid)).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  it('a timeout does the same and records a timed_out attempt', async () => {
    start();
    const job = await add(1500);
    await expect.poll(async () => (await reload(job.id)).status, { timeout: 15_000 }).toBe('dead');
    const { pid, dir } = seen.get(job.id) ?? { pid: 0, dir: '' };
    expect(pid).toBeGreaterThan(0);
    expect(await ffmpegAlive(pid)).toBe(false);
    expect(existsSync(dir)).toBe(false);
    expect((await reload(job.id)).error).toMatchObject({ message: 'job timed out after 1500 ms' });
    const att: { status: string }[] = await ds.query('SELECT status FROM job_attempts WHERE job_id = $1', [
      job.id,
    ]);
    expect(att.map((a) => a.status)).toEqual(['timed_out']);
  });
});
