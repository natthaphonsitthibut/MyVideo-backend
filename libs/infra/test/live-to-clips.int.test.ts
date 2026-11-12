import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateProject } from '@myvideo/contracts';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAiService } from '../../../test/ai-service.js';
import { FOOTAGE_DIR, footageClip } from '../../../test/footage.js';
import { seedSourceFromFile } from '../../../test/ingest-helpers.js';
import { freshTestDb } from '../../../test/test-db.js';
import { AiServiceClient } from '../src/ai/ai-service.client.js';
import { shotsHandler } from '../src/ai/shots-handler.js';
import { requestTranscription, transcribeHandlers } from '../src/ai/transcribe-handlers.js';
import { ClipSuggestionEntity } from '../src/db/entities/clip-suggestion.entity.js';
import { ProjectVersionEntity } from '../src/db/entities/project.entity.js';
import { seedMerchant } from '../src/db/seed.js';
import {
  LiveToClipsUnavailableError,
  liveToClipsHandlers,
  requestLiveToClips,
} from '../src/highlights/live-to-clips.js';
import { HandlerRegistry } from '../src/jobs/handlers.js';
import { JobRunner } from '../src/jobs/runner.js';
import { RulesOnlyLlm } from '../src/llm/structured-llm.js';
import { audioHandler } from '../src/media/audio-handler.js';
import { probeHandler } from '../src/media/ingest-handlers.js';
import { loadStageBundle } from '../src/render/stage-bundle.js';
import { StageTextLayout } from '../src/render/text-layout.js';
import { LocalStorage } from '../src/storage/local-storage.js';

const CLIP = 'live-tiedye-th-vertical-b.mp4'; // C02 = S01 @ 20:00, 55 s, real Thai live selling
const has = !!footageClip(CLIP);

describe.skipIf(!has)(
  'live-to-clips run on a real live-selling clip (rules mode)',
  { timeout: 600_000 },
  () => {
    let ds: DataSource;
    let merchantId: string;
    let ai: AiServiceClient;
    let stopAi: () => void;
    let sourceId: string;
    const root = mkdtempSync(join(tmpdir(), 'myvideo-l2c-'));
    const storage = new LocalStorage(join(root, 'storage'));
    const registry = async () => {
      const bundle = await loadStageBundle();
      const r = new HandlerRegistry()
        .register(probeHandler({ ds, storage }))
        .register(audioHandler({ ds, storage }))
        .register(shotsHandler({ ds, storage, ai }));
      for (const h of transcribeHandlers({ ds, storage, ai, maxChunkMs: 60_000 })) r.register(h);
      for (const h of liveToClipsHandlers({
        ds,
        storage,
        ai,
        llm: new RulesOnlyLlm(),
        openLayout: () => StageTextLayout.open(bundle),
      }))
        r.register(h);
      return r;
    };

    async function drain(runId: string, runner: JobRunner): Promise<string[]> {
      const ran: string[] = [];
      for (;;) {
        const [rows]: [{ id: string; type: string }[], number] = await ds.query(
          `UPDATE jobs SET status = 'queued' WHERE id = (
           SELECT id FROM jobs WHERE workflow_run_id = $1 AND status IN ('pending', 'queued')
            ORDER BY step_index, created_at, id LIMIT 1) RETURNING id, type`,
          [runId],
        );
        const job = rows[0];
        if (!job) return ran;
        expect(await runner.run(job.id)).toBe('succeeded');
        ran.push(job.type);
      }
    }

    beforeAll(async () => {
      process.env.AI_ALLOWED_ROOTS = [root, tmpdir()].join(':');
      const svc = await startAiService(20_000 + Math.floor(Math.random() * 1000));
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
      const s = await seedSourceFromFile(ds, storage, merchantId, `${FOOTAGE_DIR}/clips/${CLIP}`);
      sourceId = s.sourceId;
      const runner = new JobRunner(ds, await registry(), { workerId: 'ingest' });
      await ds.query(`UPDATE jobs SET status = 'queued' WHERE id = $1`, [s.jobId]);
      expect(await runner.run(s.jobId)).toBe('succeeded');
      const audioJob = await ds.query(
        `INSERT INTO jobs (merchant_id, workflow_run_id, type, queue, idempotency_key, payload, status, step_index)
       VALUES ($1, $2, 'media.audio', 'media', $3, $4, 'queued', 2) RETURNING id`,
        [merchantId, s.runId, `t-audio-${sourceId}`, JSON.stringify({ sourceId })],
      );
      expect(await runner.run(audioJob[0].id)).toBe('succeeded');
      await ds.query(`DELETE FROM jobs WHERE workflow_run_id = $1 AND status = 'pending'`, [s.runId]);
      await ds.query(`UPDATE video_sources SET status = 'ready' WHERE id = $1`, [sourceId]);
    }, 120_000);
    afterAll(async () => {
      stopAi?.();
      await ds?.destroy();
      rmSync(root, { recursive: true, force: true });
    });

    it('refuses a source without a finished transcript', async () => {
      await expect(requestLiveToClips(ds, { merchantId, sourceId })).rejects.toBeInstanceOf(
        LiveToClipsUnavailableError,
      );
    });

    it('shots → plan → one build per clip: valid editable projects on clean boundaries', async () => {
      const t = await requestTranscription(ds, { merchantId, sourceId });
      await drain(t.runId, new JobRunner(ds, await registry(), { workerId: 'asr' }));

      const product = { name: 'เสื้อมัดย้อม' };
      const { runId, created } = await requestLiveToClips(ds, { merchantId, sourceId, product });
      expect(created).toBe(true);
      expect((await requestLiveToClips(ds, { merchantId, sourceId })).runId).toBe(runId); // joins while running

      const ran = await drain(runId, new JobRunner(ds, await registry(), { workerId: 'w' }));
      expect(ran.slice(0, 2)).toEqual(['shots.detect', 'clips.plan']);
      const clips = await ds
        .getRepository(ClipSuggestionEntity)
        .find({ where: { workflowRunId: runId }, order: { rank: 'ASC' } });
      expect(clips.length).toBeGreaterThan(0);
      expect(ran.filter((x) => x === 'clips.build')).toHaveLength(clips.length);
      expect((await ds.query(`SELECT status FROM workflow_runs WHERE id = $1`, [runId]))[0].status).toBe(
        'succeeded',
      );

      for (const c of clips) {
        expect(c).toMatchObject({ status: 'ready', mode: 'rules', origin: 'rules' });
        expect(c.endMs - c.startMs).toBeGreaterThanOrEqual(15_000);
        expect(c.endMs - c.startMs).toBeLessThanOrEqual(60_000);
        expect(c.score).toBeGreaterThan(0);
        expect(c.score).toBeLessThanOrEqual(100);
        expect(c.reason.length).toBeGreaterThan(0);
        const v = await ds
          .getRepository(ProjectVersionEntity)
          .findOneByOrFail({ projectId: c.projectId ?? '', version: 1 });
        expect(validateProject(v.doc).ok).toBe(true);
        const doc = v.doc as { meta: { createdBy: string; workflowRunId: string }; durationFrames: number };
        expect(doc.meta).toMatchObject({ createdBy: 'ai', workflowRunId: runId });
        console.log(
          `rank ${c.rank}: ${(c.startMs / 1000).toFixed(2)}–${(c.endMs / 1000).toFixed(2)} s score ${c.score} title "${c.title}" hook "${c.hook}"`,
        );
      }
      // no two clips overlap
      for (let i = 1; i < clips.length; i++) {
        const sorted = [...clips].sort((a, b) => a.startMs - b.startMs);
        expect(sorted[i]?.startMs ?? 0).toBeGreaterThanOrEqual(sorted[i - 1]?.endMs ?? 0);
      }
    });

    it('re-running a finished build does nothing (idempotent)', async () => {
      const before = await ds.getRepository(ProjectVersionEntity).count();
      const run = (await ds.query(`SELECT id FROM workflow_runs WHERE kind = 'live_to_clips'`))[0]
        .id as string;
      const job = await ds.query(
        `INSERT INTO jobs (merchant_id, workflow_run_id, type, queue, idempotency_key, payload, status, step_index)
       VALUES ($1, $2, 'clips.build', 'ai', $3, $4, 'queued', 9) RETURNING id`,
        [merchantId, run, `again-${run}`, JSON.stringify({ sourceId, rank: 1 })],
      );
      expect(await new JobRunner(ds, await registry(), { workerId: 'w2' }).run(job[0].id)).toBe('succeeded');
      expect(await ds.getRepository(ProjectVersionEntity).count()).toBe(before);
    });
  },
);
