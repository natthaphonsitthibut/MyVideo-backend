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
import { requestTranscription, transcribeHandlers } from '../src/ai/transcribe-handlers.js';
import { ClipSuggestionEntity } from '../src/db/entities/clip-suggestion.entity.js';
import { ProjectVersionEntity } from '../src/db/entities/project.entity.js';
import { seedMerchant } from '../src/db/seed.js';
import { parseClipBuildInput } from '../src/highlights/clip-build-input.js';
import { TAIL_MS } from '../src/highlights/clip-ending.js';
import {
  LiveToClipsUnavailableError,
  liveToClipsHandlers,
  requestBuildClips,
  requestLiveToClips,
} from '../src/highlights/live-to-clips.js';
import { clipsRestyleHandler, requestRestyle } from '../src/highlights/restyle.js';
import { HandlerRegistry } from '../src/jobs/handlers.js';
import { JobRunner } from '../src/jobs/runner.js';
import { RulesOnlyLlm } from '../src/llm/structured-llm.js';
import { audioHandler } from '../src/media/audio-handler.js';
import { probeHandler } from '../src/media/ingest-handlers.js';
import { loadStageBundle } from '../src/render/stage-bundle.js';
import { StageTextLayout } from '../src/render/text-layout.js';
import { LocalStorage } from '../src/storage/local-storage.js';

const CLIP = 'live-tiedye-th-vertical-b.mp4'; // C02 = S01 @ 20:00, 55 s, real Thai live selling

/** All caption words of a project in time order, joined. */
function captionText(p: Project): string {
  return Object.values(p.elements)
    .flatMap((e) =>
      e.type === 'caption' ? [{ at: e.startFrame, text: e.words.map((w) => w.text).join('') }] : [],
    )
    .sort((a, b) => a.at - b.at)
    .map((x) => x.text)
    .join('');
}

/** The pieces of `full` missing from `part`, when `part` is `full` with whole chunks taken out; null otherwise. */
function missingChunks(part: string, full: string): string[] | null {
  const a = [...part];
  const b = [...full];
  const chunks: string[] = [];
  let i = 0;
  let open = '';
  for (const ch of b) {
    if (i < a.length && a[i] === ch) {
      if (open) chunks.push(open);
      open = '';
      i++;
    } else open += ch;
  }
  if (open) chunks.push(open);
  return i === a.length ? chunks : null;
}
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

      // analysis only: clips are found and styles recommended, nothing is edited before the merchant picks a style
      const ran = await drain(runId, new JobRunner(ds, await registry(), { workerId: 'w' }));
      expect(ran).toEqual(['shots.detect', 'clips.plan']);
      expect((await ds.query(`SELECT status FROM workflow_runs WHERE id = $1`, [runId]))[0].status).toBe(
        'succeeded',
      );
      const planned = await ds.getRepository(ClipSuggestionEntity).find({ where: { workflowRunId: runId } });
      expect(planned.length).toBeGreaterThan(0);
      expect(planned.every((c) => c.status === 'planned' && c.projectId === null)).toBe(true);
      const planResult = (
        await ds.query(`SELECT result FROM jobs WHERE workflow_run_id = $1 AND type = 'clips.plan'`, [runId])
      )[0].result as { advice: { origin: string; items: { styleId: string; reason: string }[] } };
      // rules mode: the measured-features ranking, every style once, each with a reason
      expect(planResult.advice.origin).toBe('rules');
      expect(planResult.advice.items.map((x) => x.styleId).sort()).toEqual([
        'friendly',
        'fun',
        'premium',
        'sale-fast',
        'simple',
      ]);
      console.log(`style advice: ${JSON.stringify(planResult.advice.items)}`);

      // the merchant picks a style → a build run edits every planned clip; asking again joins it
      const build = await requestBuildClips(ds, { merchantId, sourceId, styleId: 'sale-fast' });
      expect(build.created).toBe(true);
      expect((await requestBuildClips(ds, { merchantId, sourceId, styleId: 'sale-fast' })).runId).toBe(
        build.runId,
      );
      const built = await drain(build.runId, new JobRunner(ds, await registry(), { workerId: 'w' }));
      const clips = await ds
        .getRepository(ClipSuggestionEntity)
        .find({ where: { workflowRunId: runId }, order: { rank: 'ASC' } });
      expect(built.filter((x) => x === 'clips.build')).toHaveLength(clips.length);
      await expect(requestBuildClips(ds, { merchantId, sourceId, styleId: 'fun' })).rejects.toMatchObject({
        reason: 'not_analysed', // every clip is built now
      });

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
        expect(doc.meta).toMatchObject({ createdBy: 'ai', workflowRunId: runId, styleId: 'sale-fast' });
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

    it('restyle rebuilds a clip with another style from its stored input — no AI call, a new version', async () => {
      const clip = await ds
        .getRepository(ClipSuggestionEntity)
        .findOneOrFail({ where: { merchantId, status: 'ready' }, order: { rank: 'ASC' } });
      const projectId = clip.projectId ?? '';
      // the build stored what it gave the builder
      const stored = parseClipBuildInput(clip.buildInput);
      expect(stored).not.toBeNull();
      expect(stored?.startMs).toBe(clip.startMs);
      // the build keeps a short breath after the last word (clipEndWithTail), never more than TAIL_MS
      expect(stored?.endMs).toBeGreaterThanOrEqual(clip.endMs);
      expect(stored?.endMs).toBeLessThanOrEqual(clip.endMs + TAIL_MS);
      expect(stored?.words.length).toBeGreaterThan(0);
      expect(stored?.title).toBe(clip.title);

      const v1 = await ds.getRepository(ProjectVersionEntity).findOneByOrFail({ projectId, version: 1 });
      const llmCallsBefore = Number((await ds.query(`SELECT count(*) AS n FROM llm_calls`))[0].n);
      // the restyle handler is given no LLM at all (it has no such dependency); llm_calls must not grow either
      const bundle = await loadStageBundle();
      const reg = new HandlerRegistry().register(
        clipsRestyleHandler({ ds, openLayout: () => StageTextLayout.open(bundle) }),
      );
      const restyle = async (styleId: string) => {
        const { runId } = await requestRestyle(ds, { merchantId, projectId, styleId });
        expect(await drain(runId, new JobRunner(ds, reg, { workerId: 'restyle' }))).toEqual([
          'clips.restyle',
        ]);
        expect((await ds.query(`SELECT status FROM workflow_runs WHERE id = $1`, [runId]))[0].status).toBe(
          'succeeded',
        );
      };

      await restyle('premium');
      const versions = await ds
        .getRepository(ProjectVersionEntity)
        .find({ where: { projectId }, order: { version: 'ASC' } });
      expect(versions.map((v) => [v.version, v.reason])).toEqual([
        [1, 'create'],
        [2, 'restyle'],
      ]);
      const v2 = versions[1]?.doc as Project;
      expect(validateProject(v2).ok).toBe(true);
      expect(v2.meta).toMatchObject({ createdBy: 'ai', styleId: 'premium' });
      expect((v1.doc as Project).meta.styleId).not.toBe('premium');
      // same words on screen (only the look and cuts change); the one allowed difference: sale-fast shows a spoken
      // price as a price tag and drops the caption page under it, premium has no tag so that page stays a caption
      const missing = missingChunks(captionText(v1.doc as Project), captionText(v2));
      expect(missing).not.toBeNull();
      const tagDigits = Object.values((v1.doc as Project).elements).flatMap((e) =>
        e.type === 'text' ? [e.content.replace(/[^\d]/g, '')] : [],
      );
      for (const chunk of missing ?? []) {
        const digits = chunk.replace(/[^\d]/g, '');
        expect(digits.length).toBeGreaterThan(0);
        expect(tagDigits.some((d) => d.length > 0 && digits.includes(d))).toBe(true);
      }
      expect(captionText(v2).length).toBeGreaterThan(0);
      // same seed → same project and ids as a fresh build of that style would give
      expect(v2.id).toBe(projectId);
      expect(Number((await ds.query(`SELECT count(*) AS n FROM llm_calls`))[0].n)).toBe(llmCallsBefore);

      // the same style again: no new version; another style: version 3; v1 still restorable as stored
      await restyle('premium');
      expect(await ds.getRepository(ProjectVersionEntity).countBy({ projectId })).toBe(2);
      await restyle('fun');
      const v3 = await ds.getRepository(ProjectVersionEntity).findOneByOrFail({ projectId, version: 3 });
      expect((v3.doc as Project).meta.styleId).toBe('fun');
      expect(
        (await ds.getRepository(ProjectVersionEntity).findOneByOrFail({ projectId, version: 1 })).doc,
      ).toEqual(v1.doc);

      // another merchant cannot restyle it; unknown styles are refused
      const other = await seedMerchant(ds, {
        merchantName: 'B',
        merchantSlug: 'shop-b',
        email: 'b@b.local',
        password: 'password-b',
        displayName: 'B',
      });
      await expect(
        requestRestyle(ds, { merchantId: other.merchant.id, projectId, styleId: 'fun' }),
      ).rejects.toMatchObject({ reason: 'not_found' });
      await expect(requestRestyle(ds, { merchantId, projectId, styleId: 'nope' })).rejects.toMatchObject({
        reason: 'unknown_style',
      });
      // a clip built before build inputs were stored
      await ds.query(`UPDATE clip_suggestions SET build_input = NULL WHERE id = $1`, [clip.id]);
      await expect(requestRestyle(ds, { merchantId, projectId, styleId: 'simple' })).rejects.toMatchObject({
        reason: 'no_build_input',
      });
      await ds.query(`UPDATE clip_suggestions SET build_input = $2 WHERE id = $1`, [
        clip.id,
        JSON.stringify(clip.buildInput),
      ]);
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
