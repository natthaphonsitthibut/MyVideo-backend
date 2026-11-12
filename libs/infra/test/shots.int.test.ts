import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAiService } from '../../../test/ai-service.js';
import { FOOTAGE_DIR, footageClip } from '../../../test/footage.js';
import { seedSourceFromFile } from '../../../test/ingest-helpers.js';
import { freshTestDb } from '../../../test/test-db.js';
import { AiServiceClient } from '../src/ai/ai-service.client.js';
import { shotsHandler } from '../src/ai/shots-handler.js';
import { AnalysisEntity, DetectedShotEntity } from '../src/db/entities/analysis.entity.js';
import { seedMerchant } from '../src/db/seed.js';
import { HandlerRegistry } from '../src/jobs/handlers.js';
import { JobRunner } from '../src/jobs/runner.js';
import { probeHandler } from '../src/media/ingest-handlers.js';
import { LocalStorage } from '../src/storage/local-storage.js';

/** Counts real `/shots` calls so the test can prove which parts were (not) analysed again. */
class CountingAi extends AiServiceClient {
  shotCalls: { startMs?: number; endMs?: number }[] = [];
  override shots(...args: Parameters<AiServiceClient['shots']>) {
    this.shotCalls.push({ startMs: args[1]?.startMs, endMs: args[1]?.endMs });
    return super.shots(...args);
  }
}

const CLIP = 'broll-gpu-unboxing-silent.mp4'; // C05 = S05 0–30 s, no audio
const has = !!footageClip(CLIP);
const labels = JSON.parse(readFileSync(`${FOOTAGE_DIR}/labels/shots/S05.shots.json`, 'utf8')) as {
  cuts: { t: number }[];
  match_tolerance_s: number;
};

describe.skipIf(!has)('shots.detect on real b-roll (C05), part by part', { timeout: 300_000 }, () => {
  let ds: DataSource;
  let merchantId: string;
  let ai: CountingAi;
  let stopAi: () => void;
  const root = mkdtempSync(join(tmpdir(), 'myvideo-shots-'));
  const storage = new LocalStorage(join(root, 'storage'));
  let sourceId: string;
  let runId: string;

  beforeAll(async () => {
    process.env.AI_ALLOWED_ROOTS = [root, tmpdir()].join(':');
    const svc = await startAiService(19_000 + Math.floor(Math.random() * 1000));
    stopAi = svc.stop;
    ai = new CountingAi({ baseUrl: svc.url });
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
    const s = await seedSourceFromFile(ds, storage, merchantId, `${FOOTAGE_DIR}/clips/${CLIP}`);
    const runner = new JobRunner(ds, new HandlerRegistry().register(probeHandler({ ds, storage })), {
      workerId: 'ingest',
    });
    await ds.query(`UPDATE jobs SET status = 'queued' WHERE id = $1`, [s.jobId]);
    expect(await runner.run(s.jobId)).toBe('succeeded');
    await ds.query(`DELETE FROM jobs WHERE workflow_run_id = $1 AND status = 'pending'`, [s.runId]);
    await ds.query(`UPDATE video_sources SET status = 'ready' WHERE id = $1`, [s.sourceId]);
    sourceId = s.sourceId;
    const run = await ds.query(
      `INSERT INTO workflow_runs (merchant_id, kind, status, subject_type, subject_id)
       VALUES ($1, 'live_to_clips', 'running', 'source', $2) RETURNING id`,
      [merchantId, sourceId],
    );
    runId = run[0].id;
  }, 60_000);
  afterAll(async () => {
    stopAi?.();
    await ds?.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  const runShots = async (n: number) => {
    const runner = new JobRunner(
      ds,
      new HandlerRegistry().register(shotsHandler({ ds, storage, ai, partMs: 10_000 })),
      {
        workerId: 'w',
      },
    );
    const job = await ds.query(
      `INSERT INTO jobs (merchant_id, workflow_run_id, type, queue, idempotency_key, payload, status, step_index)
       VALUES ($1, $2, 'shots.detect', 'ai', $3, $4, 'queued', 1) RETURNING id`,
      [merchantId, runId, `shots-${n}`, JSON.stringify({ sourceId })],
    );
    expect(await runner.run(job[0].id)).toBe('succeeded');
    return job[0].id as string;
  };

  it('analyses 3 parts with rising progress, stores shots + keyframes, finds the counted cuts', async () => {
    const jobId = await runShots(1);
    expect(ai.shotCalls).toEqual([
      { startMs: 0, endMs: 10_000 },
      { startMs: 10_000, endMs: 20_000 },
      { startMs: 20_000, endMs: 30_000 },
    ]);
    const events: { progress: number | null }[] = await ds.query(
      `SELECT progress FROM job_events WHERE job_id = $1 AND progress IS NOT NULL ORDER BY id`,
      [jobId],
    );
    const p = events.map((e) => Number(e.progress));
    expect(p).toEqual([...p].sort((a, b) => a - b));
    expect(p.at(-1)).toBe(1);

    const shots = await ds
      .getRepository(DetectedShotEntity)
      .find({ where: { merchantId }, order: { seq: 'ASC' } });
    expect(shots[0]?.startMs).toBe(0);
    expect(shots.at(-1)?.endMs).toBeGreaterThanOrEqual(29_900);
    for (let i = 1; i < shots.length; i++) expect(shots[i]?.startMs).toBe(shots[i - 1]?.endMs);
    for (const s of shots) {
      expect(s.keyframes.length).toBeGreaterThanOrEqual(1);
      for (const k of s.keyframes) {
        expect(k.tMs).toBeGreaterThan(s.startMs);
        expect(k.tMs).toBeLessThan(s.endMs);
        expect((await storage.stat(k.storageKey))?.size).toBeGreaterThan(1000);
      }
    }
    // agent-counted cuts of S05 inside 0–30 s (footage/labels/shots/S05.shots.json)
    const truth = labels.cuts.map((c) => c.t).filter((t) => t < 29.5);
    const cuts = shots.slice(1).map((s) => s.startMs / 1000);
    const found = truth.filter((t) => cuts.some((c) => Math.abs(c - t) <= labels.match_tolerance_s));
    console.log(
      `C05 parts=3 shots=${shots.length} recall=${found.length}/${truth.length} cuts=${cuts.join(',')}`,
    );
    expect(found.length / truth.length).toBeGreaterThanOrEqual(0.75);
  });

  it('resumes only the unfinished part after a crash, and a finished analysis is a cache hit', async () => {
    const repo = ds.getRepository(AnalysisEntity);
    const a = await repo.findOneByOrFail({ merchantId, sourceId });
    const parts = a.parts.map((p) => (p.index === 1 ? { ...p, done: false, shots: undefined } : p));
    await repo.update({ id: a.id }, { status: 'running', parts });
    ai.shotCalls = [];
    await runShots(2);
    expect(ai.shotCalls).toEqual([{ startMs: 10_000, endMs: 20_000 }]);
    expect((await repo.findOneByOrFail({ id: a.id })).status).toBe('ready');

    ai.shotCalls = [];
    await runShots(3);
    expect(ai.shotCalls).toEqual([]);
  });
});
