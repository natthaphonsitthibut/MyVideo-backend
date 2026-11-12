import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FOOTAGE_DIR, footageClip } from '../../../test/footage.js';
import { seedSourceFromFile } from '../../../test/ingest-helpers.js';
import { freshTestDb } from '../../../test/test-db.js';
import { JobEntity } from '../src/db/entities/job.entity.js';
import { MediaAssetEntity } from '../src/db/entities/media-asset.entity.js';
import { seedMerchant } from '../src/db/seed.js';
import { HandlerRegistry } from '../src/jobs/handlers.js';
import { JobRunner } from '../src/jobs/runner.js';
import { probeHandler } from '../src/media/ingest-handlers.js';
import { probeFile } from '../src/media/probe.js';
import { proxyHandler } from '../src/media/proxy-handler.js';
import { LocalStorage } from '../src/storage/local-storage.js';

const has = !!footageClip('talkinghead-th-portrait.mp4');

describe.skipIf(!has)('media.proxy on real footage', { timeout: 120_000 }, () => {
  let ds: DataSource;
  let merchantId: string;
  const root = mkdtempSync(join(tmpdir(), 'myvideo-proxy-'));
  const storage = new LocalStorage(root);
  const registry = (segmentSeconds: number) =>
    new HandlerRegistry()
      .register(probeHandler({ ds, storage }))
      .register(proxyHandler({ ds, storage, encoder: 'libx264', segmentSeconds }));
  const run = async (r: JobRunner, jobId: string) => {
    await ds.query(`UPDATE jobs SET status = 'queued' WHERE id = $1`, [jobId]);
    return r.run(jobId);
  };
  const nextJob = (runId: string, type: string) =>
    ds.getRepository(JobEntity).findOneByOrFail({ workflowRunId: runId, type });

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
  afterAll(async () => {
    await ds.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  it('builds a validated 540p/30 fps proxy in segments and queues the audio step', async () => {
    const runner = new JobRunner(ds, registry(20), { workerId: 'w', progressThrottleMs: 0 });
    const s = await seedSourceFromFile(
      ds,
      storage,
      merchantId,
      `${FOOTAGE_DIR}/clips/review-multimeter-th-hands.mp4`,
    );
    expect(await run(runner, s.jobId)).toBe('succeeded');
    const proxyJob = await nextJob(s.runId, 'media.proxy');
    expect(await run(runner, proxyJob.id)).toBe('succeeded');
    const asset = await ds
      .getRepository(MediaAssetEntity)
      .findOneByOrFail({ sourceId: s.sourceId, kind: 'proxy' });
    expect(asset.meta).toMatchObject({
      width: 960,
      height: 540,
      fps: { num: 30, den: 1 },
      segments: 3,
      encoder: 'libx264',
    });
    const file = await storage.localPath(asset.storageKey);
    const p = await probeFile(file.path);
    expect(p.ok && p.info.video).toMatchObject({ width: 960, height: 540, vfr: false });
    expect(p.ok && Math.abs(p.info.durationMs - 55_000)).toBeLessThan(200);
    expect(p.ok && p.info.audio).toMatchObject({ codec: 'aac', channels: 2 });
    const progressEvents: { progress: number }[] = await ds.query(
      `SELECT progress FROM job_events WHERE job_id = $1 AND progress > 0 AND progress < 1 ORDER BY id`,
      [proxyJob.id],
    );
    expect(progressEvents.length).toBeGreaterThan(2);
    expect((await nextJob(s.runId, 'media.audio')).status).toBe('pending');
    expect(await storage.list(`m/${merchantId}/sources/${s.sourceId}/derived/work-`)).toEqual([]); // parts cleaned
  });

  it('resumes after a cancel: finished parts are reused, not re-encoded', async () => {
    const runner = new JobRunner(ds, registry(15), {
      workerId: 'w2',
      heartbeatMs: 100,
      progressThrottleMs: 0,
    });
    const s = await seedSourceFromFile(
      ds,
      storage,
      merchantId,
      `${FOOTAGE_DIR}/clips/talkinghead-th-portrait.mp4`,
    );
    await run(runner, s.jobId);
    const proxyJob = await nextJob(s.runId, 'media.proxy');
    await ds.query(`UPDATE jobs SET max_attempts = 3 WHERE id = $1`, [proxyJob.id]);
    const running = run(runner, proxyJob.id);
    // cancel once the first part is in storage
    const partPrefix = `m/${merchantId}/sources/${s.sourceId}/derived/work-${proxyJob.id}/`;
    await expect
      .poll(async () => (await storage.list(partPrefix)).length, { timeout: 60_000, interval: 50 })
      .toBeGreaterThan(0);
    await ds.query('UPDATE jobs SET cancel_requested = true WHERE id = $1', [proxyJob.id]);
    expect(await running).toBe('cancelled');
    const kept = (await storage.list(partPrefix)).length;
    expect(kept).toBeGreaterThan(0);
    // retry
    await ds.query(`UPDATE jobs SET status = 'pending', cancel_requested = false WHERE id = $1`, [
      proxyJob.id,
    ]);
    expect(await run(runner, proxyJob.id)).toBe('succeeded');
    const asset = await ds
      .getRepository(MediaAssetEntity)
      .findOneByOrFail({ sourceId: s.sourceId, kind: 'proxy' });
    expect(asset.meta).toMatchObject({ segments: 4, width: 540, height: 676 }); // 576×720 portrait → short side 540
    expect(Number(asset.meta.reusedSegments)).toBeGreaterThanOrEqual(kept);
  });

  it('is idempotent: a second run reuses the existing proxy', async () => {
    const runner = new JobRunner(ds, registry(300), { workerId: 'w3' });
    const s = await seedSourceFromFile(
      ds,
      storage,
      merchantId,
      `${FOOTAGE_DIR}/clips/broll-gpu-unboxing-silent.mp4`,
    );
    await run(runner, s.jobId);
    const proxyJob = await nextJob(s.runId, 'media.proxy');
    await run(runner, proxyJob.id);
    const asset = await ds
      .getRepository(MediaAssetEntity)
      .findOneByOrFail({ sourceId: s.sourceId, kind: 'proxy' });
    expect(asset.meta).toMatchObject({ width: 960, height: 540 }); // 1080p 50 fps silent → 540p 30 fps, no audio
    const again = await proxyHandler({ ds, storage, encoder: 'libx264', segmentSeconds: 300 }).run({
      job: proxyJob,
      attempt: 2,
      signal: new AbortController().signal,
      progress: async () => {},
    });
    expect(again).toEqual({ assetId: asset.id, reused: true });
  });
});
