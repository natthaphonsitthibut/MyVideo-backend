import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FOOTAGE_DIR, footageClip } from '../../../test/footage.js';
import { seedSourceFromFile } from '../../../test/ingest-helpers.js';
import { freshTestDb } from '../../../test/test-db.js';
import { JobEntity } from '../src/db/entities/job.entity.js';
import { VideoSourceEntity } from '../src/db/entities/video-source.entity.js';
import { seedMerchant } from '../src/db/seed.js';
import { HandlerRegistry } from '../src/jobs/handlers.js';
import { JobRunner } from '../src/jobs/runner.js';
import { probeHandler } from '../src/media/ingest-handlers.js';
import { probeFile } from '../src/media/probe.js';
import { LocalStorage } from '../src/storage/local-storage.js';

// Real files from the workspace footage set (CI has none; the same logic is covered there by recorded
// ffprobe fixtures in src/media/probe.test.ts).
const has = !!footageClip('talkinghead-th-portrait.mp4');
const clip = (p: string) => `${FOOTAGE_DIR}/clips/${p}`;

describe.skipIf(!has)('probe on real footage files', () => {
  it.each([
    ['live-tiedye-th-vertical-a.mp4', { width: 406, height: 720, rotation: 0, vfr: false }],
    ['review-multimeter-th-hands.mp4', { width: 1280, height: 720, rotation: 0, vfr: false }],
    ['rotated-meta-talkinghead.mp4', { width: 720, height: 576, rotation: 90 }],
    ['vfr-talkinghead-derived.mp4', { vfr: true, fps: { num: 30, den: 1 } }],
  ])('%s', async (file, expected) => {
    const r = await probeFile(clip(file));
    expect(r.ok).toBe(true);
    expect(r.ok && r.info.video).toMatchObject(expected);
  });

  it.each([
    ['invalid/truncated-talking-head.mp4', 'truncated'],
    ['invalid/text-renamed.mp4', 'unreadable'],
    ['audio-only-th-vlog.m4a', 'no_video'],
  ])('rejects %s as %s', async (file, reason) => {
    expect(await probeFile(clip(file))).toMatchObject({ ok: false, reason });
  });
});

describe.skipIf(!has)('media.probe step (real Postgres, real files)', () => {
  let ds: DataSource;
  let merchantId: string;
  const root = mkdtempSync(join(tmpdir(), 'myvideo-probe-'));
  const storage = new LocalStorage(root);
  let runner: JobRunner;
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
    runner = new JobRunner(ds, new HandlerRegistry().register(probeHandler({ ds, storage })), {
      workerId: 'w-probe',
    });
  });
  afterAll(async () => {
    await ds.destroy();
    rmSync(root, { recursive: true, force: true });
  });
  const runJob = async (jobId: string) => {
    await ds.query(`UPDATE jobs SET status = 'queued' WHERE id = $1`, [jobId]);
    return runner.run(jobId);
  };

  it('stores normalised metadata and queues the proxy step in the same commit', async () => {
    const s = await seedSourceFromFile(ds, storage, merchantId, clip('live-tiedye-th-vertical-a.mp4'));
    expect(await runJob(s.jobId)).toBe('succeeded');
    const src = await ds.getRepository(VideoSourceEntity).findOneByOrFail({ id: s.sourceId });
    expect(src.probe).toMatchObject({
      orientation: 'portrait',
      video: { width: 406, height: 720, durationFrames: 1500 },
    });
    const next = await ds
      .getRepository(JobEntity)
      .findOneByOrFail({ workflowRunId: s.runId, type: 'media.proxy' });
    expect(next).toMatchObject({ status: 'pending', stepIndex: 1, payload: { sourceId: s.sourceId } });
  });

  it('ends a truncated upload dead with a Thai reason on the source and a failed run (not stuck)', async () => {
    const s = await seedSourceFromFile(ds, storage, merchantId, clip('invalid/truncated-talking-head.mp4'));
    expect(await runJob(s.jobId)).toBe('dead');
    const job = await ds.getRepository(JobEntity).findOneByOrFail({ id: s.jobId });
    expect(job).toMatchObject({ status: 'dead', attempts: 1 });
    const src = await ds.getRepository(VideoSourceEntity).findOneByOrFail({ id: s.sourceId });
    expect(src.status).toBe('failed');
    expect(src.failureReason).toMatch(/ไฟล์วิดีโอไม่ครบ/);
    const run: { status: string }[] = await ds.query('SELECT status FROM workflow_runs WHERE id = $1', [
      s.runId,
    ]);
    expect(run[0]?.status).toBe('failed');
    expect(await ds.getRepository(JobEntity).countBy({ workflowRunId: s.runId, type: 'media.proxy' })).toBe(
      0,
    );
  });

  it('rejects a renamed text file the same way', async () => {
    const s = await seedSourceFromFile(ds, storage, merchantId, clip('invalid/text-renamed.mp4'));
    expect(await runJob(s.jobId)).toBe('dead');
    expect(
      (await ds.getRepository(VideoSourceEntity).findOneByOrFail({ id: s.sourceId })).failureReason,
    ).toMatch(/เปิดไฟล์นี้ไม่ได้/);
  });
});
