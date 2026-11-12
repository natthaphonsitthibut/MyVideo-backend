import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Project, validateProject } from '@myvideo/contracts';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAiService } from '../../../test/ai-service.js';
import { FOOTAGE_DIR, footageClip } from '../../../test/footage.js';
import { seedSourceFromFile } from '../../../test/ingest-helpers.js';
import { freshTestDb } from '../../../test/test-db.js';
import { AiServiceClient } from '../src/ai/ai-service.client.js';
import { shotsHandler } from '../src/ai/shots-handler.js';
import { ProjectVersionEntity } from '../src/db/entities/project.entity.js';
import { seedMerchant } from '../src/db/seed.js';
import { HandlerRegistry } from '../src/jobs/handlers.js';
import { JobRunner } from '../src/jobs/runner.js';
import { probeHandler } from '../src/media/ingest-handlers.js';
import { loadStageBundle } from '../src/render/stage-bundle.js';
import { StageTextLayout } from '../src/render/text-layout.js';
import { LocalStorage } from '../src/storage/local-storage.js';
import {
  type ReviewResult,
  requestReviewVideo,
  reviewBuildHandler,
} from '../src/templates/review-to-video.js';

// real footage: C05 GPU unboxing (silent, 30 s, many shots) + C04 multimeter review (hands + voice-over, 55 s)
const CLIPS = ['broll-gpu-unboxing-silent.mp4', 'review-multimeter-th-hands.mp4'];
const has = CLIPS.every((c) => !!footageClip(c));

describe.skipIf(!has)('review-to-video on real phone-style clips', { timeout: 600_000 }, () => {
  let ds: DataSource;
  let merchantId: string;
  let ai: AiServiceClient;
  let stopAi: () => void;
  const sourceIds: string[] = [];
  const root = mkdtempSync(join(tmpdir(), 'myvideo-r2v-'));
  const storage = new LocalStorage(join(root, 'storage'));
  const registry = async () => {
    const bundle = await loadStageBundle();
    return new HandlerRegistry()
      .register(probeHandler({ ds, storage }))
      .register(shotsHandler({ ds, storage, ai }))
      .register(reviewBuildHandler({ ds, storage, ai, openLayout: () => StageTextLayout.open(bundle) }));
  };
  async function drain(runId: string): Promise<ReviewResult> {
    const runner = new JobRunner(ds, await registry(), { workerId: 'r2v' });
    for (;;) {
      const [rows]: [{ id: string }[], number] = await ds.query(
        `UPDATE jobs SET status = 'queued' WHERE id = (
           SELECT id FROM jobs WHERE workflow_run_id = $1 AND status IN ('pending', 'queued')
            ORDER BY step_index, created_at, id LIMIT 1) RETURNING id`,
        [runId],
      );
      const job = rows[0];
      if (!job) break;
      expect(await runner.run(job.id)).toBe('succeeded');
    }
    const r: { result: ReviewResult }[] = await ds.query(
      `SELECT result FROM jobs WHERE workflow_run_id = $1 AND type = 'review.build' AND status = 'succeeded'`,
      [runId],
    );
    expect(r).toHaveLength(1);
    return r[0]?.result as ReviewResult;
  }

  beforeAll(async () => {
    process.env.AI_ALLOWED_ROOTS = [root, tmpdir()].join(':');
    const svc = await startAiService(21_000 + Math.floor(Math.random() * 1000));
    stopAi = svc.stop;
    ai = new AiServiceClient({ baseUrl: svc.url });
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
    const runner = new JobRunner(ds, await registry(), { workerId: 'ingest' });
    for (const clip of CLIPS) {
      const s = await seedSourceFromFile(ds, storage, merchantId, `${FOOTAGE_DIR}/clips/${clip}`);
      await ds.query(`UPDATE jobs SET status = 'queued' WHERE id = $1`, [s.jobId]);
      expect(await runner.run(s.jobId)).toBe('succeeded');
      await ds.query(`DELETE FROM jobs WHERE workflow_run_id = $1 AND status = 'pending'`, [s.runId]);
      await ds.query(`UPDATE video_sources SET status = 'ready' WHERE id = $1`, [s.sourceId]);
      sourceIds.push(s.sourceId);
    }
  }, 180_000);
  afterAll(async () => {
    stopAi?.();
    await ds?.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  const product = { name: 'มัลติมิเตอร์ดิจิทัล', points: ['วัดไฟได้แม่น', 'จอใหญ่อ่านง่าย'] };

  it('review without anyone on camera: reports the missing talking head, builds nothing', async () => {
    const { runId } = await requestReviewVideo(ds, {
      merchantId,
      sourceIds,
      templateId: 'review',
      templateVersion: 1,
      product,
    });
    const r = await drain(runId);
    expect(r.status).toBe('missing');
    if (r.status === 'missing') {
      expect(r.missing[0]?.roles).toContain('talking_head');
      expect(r.missing[0]?.hint).toMatch(/พูด/);
      // every detected shot of both clips got a role, none with a face on the GPU footage
      expect(new Set(r.shots.map((s) => s.sourceId))).toEqual(new Set(sourceIds));
      expect(r.shots.filter((s) => s.role === 'talking_head')).toEqual([]);
    }
  });

  it('showcase: a valid editable project from both clips; swapping the template makes version 2', async () => {
    const { runId } = await requestReviewVideo(ds, {
      merchantId,
      sourceIds,
      templateId: 'showcase',
      templateVersion: 1,
      product,
    });
    const r = await drain(runId);
    expect(r.status).toBe('ready');
    if (r.status !== 'ready') return;
    const v1 = await ds
      .getRepository(ProjectVersionEntity)
      .findOneByOrFail({ projectId: r.projectId, version: 1 });
    const doc = v1.doc as unknown as Project;
    expect(validateProject(doc).ok).toBe(true);
    expect(doc.templateRef).toEqual({ templateId: 'showcase', templateVersion: 1 });
    const texts = Object.values(doc.elements).flatMap((e) => (e.type === 'text' ? [e.content] : []));
    // only the merchant's words: the product name, their points, the brand CTA
    expect(texts.join('|')).toContain('มัลติมิเตอร์');
    for (const t of texts)
      expect(['มัลติมิเตอร์', 'วัดไฟ', 'จอใหญ่', 'กดตะกร้า'].some((w) => t.replace(/\n/g, '').includes(w))).toBe(
        true,
      );

    const swap = await requestReviewVideo(ds, {
      merchantId,
      sourceIds,
      templateId: 'showcase',
      templateVersion: 1,
      product,
      projectId: r.projectId,
    });
    const r2 = await drain(swap.runId);
    expect(r2).toMatchObject({ status: 'ready', projectId: r.projectId });
    const v2 = await ds
      .getRepository(ProjectVersionEntity)
      .findOneByOrFail({ projectId: r.projectId, version: 2 });
    expect(v2.reason).toBe('template');
  });
});
