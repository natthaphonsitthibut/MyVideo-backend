import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderCacheKey } from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedSourceFromFile } from '../../../test/ingest-helpers.js';
import { isAlive, probeOutput, S01_PATH, s01Project } from '../../../test/render-helpers.js';
import { freshTestDb } from '../../../test/test-db.js';
import { RenderEntity } from '../src/db/entities/render.entity.js';
import { seedMerchant } from '../src/db/seed.js';
import { HandlerRegistry } from '../src/jobs/handlers.js';
import { createRunInTransaction, enqueueInTransaction } from '../src/jobs/job-store.js';
import { JobRunner } from '../src/jobs/runner.js';
import { ChromiumRenderer } from '../src/render/chromium-renderer.js';
import { renderHandler } from '../src/render/render-handler.js';
import { requestRender as requestRenderRow } from '../src/render/request-render.js';
import { loadStageBundle } from '../src/render/stage-bundle.js';
import { LocalStorage } from '../src/storage/local-storage.js';

// Real S01 footage + Chromium → run outside the sandbox on a machine with the footage folder.
describe.skipIf(!S01_PATH)('render.video job on a real project', { timeout: 600_000 }, () => {
  let ds: DataSource;
  let merchantId: string;
  const root = mkdtempSync(join(tmpdir(), 'myvideo-render-job-'));
  const storage = new LocalStorage(root);
  const pids: { browser?: number; encoder?: number } = {};

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

  /** S01 as a stored source, a project (first `frames` of the fixture) on it, and a render request. */
  let s: { sourceId: string };
  async function requestRender(frames: number, stageVersion: string) {
    s ??= await seedSourceFromFile(ds, storage, merchantId, S01_PATH as string); // 338 MB → once
    const doc = s01Project(frames);
    doc.merchantId = merchantId;
    for (const a of Object.values<any>(doc.assets)) a.sourceId = s.sourceId;
    return ds.transaction(async (em) => {
      const [project] = await em.query(
        `INSERT INTO projects (merchant_id, title) VALUES ($1, 'render test') RETURNING id`,
        [merchantId],
      );
      doc.id = project.id;
      const [version] = await em.query(
        `INSERT INTO project_versions (merchant_id, project_id, version, doc, reason) VALUES ($1, $2, 1, $3, 'create') RETURNING id`,
        [merchantId, project.id, JSON.stringify(doc)],
      );
      const run = await createRunInTransaction(em, {
        merchantId,
        kind: 'render',
        subjectType: 'project',
        subjectId: project.id,
      });
      const render = await em.getRepository(RenderEntity).save({
        merchantId,
        projectId: project.id,
        projectVersionId: version.id,
        projectVersion: 1,
        preset: 'standard',
        stageVersion,
        cacheKey: renderCacheKey(version.id, 'standard', stageVersion),
        workflowRunId: run.id,
      });
      const { job } = await enqueueInTransaction(em, {
        merchantId,
        workflowRunId: run.id,
        type: 'render.video',
        queue: 'render',
        idempotencyKey: `render:${render.id}`,
        payload: { renderId: render.id },
        maxAttempts: 1,
      });
      await em.query(`UPDATE jobs SET status = 'queued' WHERE id = $1`, [job.id]);
      return { renderId: render.id, jobId: job.id };
    });
  }

  async function runner() {
    const renderer = new ChromiumRenderer(await loadStageBundle(), {
      onBrowserPid: (p) => {
        pids.browser = p;
      },
      onEncoderPid: (p) => {
        pids.encoder = p;
      },
    });
    const registry = new HandlerRegistry().register(renderHandler({ ds, storage, renderer }));
    return {
      renderer,
      runner: new JobRunner(ds, registry, { workerId: 'w', progressThrottleMs: 0, heartbeatMs: 200 }),
    };
  }

  it('renders the pinned version, stores a valid MP4 and records it once', async () => {
    const { renderer, runner: r } = await runner();
    const req = await requestRender(450, renderer.stageVersion);
    expect(await r.run(req.jobId)).toBe('succeeded');
    const row = await ds.getRepository(RenderEntity).findOneByOrFail({ id: req.renderId });
    expect(row.outputKey).toMatch(new RegExp(`^m/${merchantId}/renders/${req.renderId}/output-`));
    expect(row.meta).toMatchObject({ width: 1080, height: 1920, frames: 450, hasAudio: true });
    const file = await storage.localPath(row.outputKey as string);
    const probe = await probeOutput(file.path);
    await file.release();
    expect(probe.video.frames).toBe(450);
    expect(probe.audio?.codec).toBe('aac');
    expect(Number(row.sizeBytes)).toBeGreaterThan(100_000);
  });

  it('refuses a render requested for another stage version (dead, no output)', async () => {
    const { runner: r } = await runner();
    const req = await requestRender(30, '000000000000');
    expect(await r.run(req.jobId)).toBe('dead');
    const row = await ds.getRepository(RenderEntity).findOneByOrFail({ id: req.renderId });
    expect(row.outputKey).toBeNull();
    const [job] = await ds.query(`SELECT error FROM jobs WHERE id = $1`, [req.jobId]);
    expect(job.error.message).toMatch(/stage changed/);
  });

  it('cancel while rendering → job cancelled, Chromium and ffmpeg gone, nothing recorded', async () => {
    const { renderer, runner: r } = await runner();
    const req = await requestRender(450, renderer.stageVersion);
    pids.browser = undefined;
    pids.encoder = undefined;
    const outcome = r.run(req.jobId);
    // wait until frames are being captured, then ask to cancel (what POST /jobs/:id/cancel does)
    for (let i = 0; i < 600; i++) {
      const [j] = await ds.query(`SELECT progress FROM jobs WHERE id = $1`, [req.jobId]);
      if (j.progress > 0.2) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    await ds.query(`UPDATE jobs SET cancel_requested = true WHERE id = $1`, [req.jobId]);
    expect(await outcome).toBe('cancelled');
    await new Promise((res) => setTimeout(res, 2500)); // SIGTERM → SIGKILL grace
    expect(isAlive(Number(pids.browser))).toBe(false);
    expect(isAlive(Number(pids.encoder))).toBe(false);
    const row = await ds.getRepository(RenderEntity).findOneByOrFail({ id: req.renderId });
    expect(row.outputKey).toBeNull();
  });

  it('an edit while a render is in flight: the render stays on its version, the new version gets its own', async () => {
    const { renderer, runner: r } = await runner();
    const req = await requestRender(60, renderer.stageVersion);
    const before = await ds.getRepository(RenderEntity).findOneByOrFail({ id: req.renderId });
    // the user saves version 2 (30 frames) before the worker picks the render up
    const v2doc = s01Project(30);
    v2doc.merchantId = merchantId;
    v2doc.id = before.projectId;
    for (const a of Object.values<any>(v2doc.assets)) a.sourceId = s.sourceId;
    const [v2] = await ds.query(
      `INSERT INTO project_versions (merchant_id, project_id, version, doc, reason) VALUES ($1, $2, 2, $3, 'save') RETURNING id`,
      [merchantId, before.projectId, JSON.stringify(v2doc)],
    );
    await ds.query(`UPDATE projects SET current_version = 2 WHERE id = $1`, [before.projectId]);

    expect(await r.run(req.jobId)).toBe('succeeded');
    const done = await ds.getRepository(RenderEntity).findOneByOrFail({ id: req.renderId });
    expect(done).toMatchObject({ projectVersionId: before.projectVersionId, projectVersion: 1 });
    expect(done.meta).toMatchObject({ frames: 60 }); // version 1's length, not version 2's
    const file = await storage.localPath(done.outputKey as string);
    expect((await probeOutput(file.path)).video.frames).toBe(60);
    await file.release();

    // asking for the project now renders version 2 as a NEW render; version 1's stays cached
    const next = await requestRenderRow(ds, {
      merchantId,
      projectId: before.projectId,
      preset: 'standard',
      stageVersion: renderer.stageVersion,
    });
    expect(next.outcome).toBe('created');
    expect(next.renderId).not.toBe(req.renderId);
    const row2 = await ds.getRepository(RenderEntity).findOneByOrFail({ id: next.renderId });
    expect(row2).toMatchObject({ projectVersionId: v2.id, projectVersion: 2, outputKey: null });
    const again = await requestRenderRow(ds, {
      merchantId,
      projectId: before.projectId,
      version: 1,
      preset: 'standard',
      stageVersion: renderer.stageVersion,
    });
    expect(again).toEqual({ renderId: req.renderId, outcome: 'cached' });
  });

  it('a late second attempt for a finished render cannot replace its output', async () => {
    const { renderer, runner: r } = await runner();
    const req = await requestRender(30, renderer.stageVersion);
    expect(await r.run(req.jobId)).toBe('succeeded');
    const first = await ds.getRepository(RenderEntity).findOneByOrFail({ id: req.renderId });
    // a duplicate job for the same render (e.g. an old retry still queued) runs afterwards
    const dup = await ds.transaction(async (em) => {
      const run = await createRunInTransaction(em, { merchantId, kind: 'render' });
      const { job } = await enqueueInTransaction(em, {
        merchantId,
        workflowRunId: run.id,
        type: 'render.video',
        queue: 'render',
        idempotencyKey: `late:${req.renderId}`,
        payload: { renderId: req.renderId },
      });
      await em.query(`UPDATE jobs SET status = 'queued' WHERE id = $1`, [job.id]);
      return job.id;
    });
    expect(await r.run(dup)).toBe('succeeded');
    const [j] = await ds.query(`SELECT result FROM jobs WHERE id = $1`, [dup]);
    expect(j.result).toMatchObject({ reused: true, outputKey: first.outputKey });
    const after = await ds.getRepository(RenderEntity).findOneByOrFail({ id: req.renderId });
    expect(after).toMatchObject({ outputKey: first.outputKey, sha256: first.sha256 });
    expect(await storage.list(`m/${merchantId}/renders/${req.renderId}/`)).toEqual([first.outputKey]);
  });
});
