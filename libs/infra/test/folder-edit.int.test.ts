import { uuidv7 } from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshTestDb } from '../../../test/test-db.js';
import { requestTranscription } from '../src/ai/transcribe-handlers.js';
import { seedMerchant } from '../src/db/seed.js';
import {
  chooseFolderStyle,
  folderAdvanceHandler,
  folderPlanOf,
  requestFolderEdit,
} from '../src/folders/folder-edit.js';
import { visualMontageHandler } from '../src/folders/visual-montage.js';
import { HandlerRegistry } from '../src/jobs/handlers.js';
import { JobRunner, refreshRunStatus } from '../src/jobs/runner.js';

/**
 * The folder edit orchestration on real Postgres: which child workflows it starts, when it wakes, and what the plan
 * says. Child workflows themselves (ASR, analysis, build) are not executed here — their runs are moved to a
 * terminal state through the same `refreshRunStatus` path the job runner uses.
 */
describe('folder edit orchestration (real Postgres)', () => {
  let ds: DataSource;
  let m: string;
  let folder: string;
  const runner = () =>
    new JobRunner(
      ds,
      new HandlerRegistry().register(folderAdvanceHandler({ ds })).register(visualMontageHandler({ ds })),
      { workerId: 'fe' },
    );
  const pendingAdvance = async (runId: string): Promise<string[]> =>
    (
      (await ds.query(
        `SELECT id FROM jobs WHERE workflow_run_id = $1 AND type = 'folder.advance' AND status = 'pending' ORDER BY created_at`,
        [runId],
      )) as { id: string }[]
    ).map((r) => r.id);
  const runAdvance = async (runId: string) => {
    const ids = await pendingAdvance(runId);
    for (const id of ids) {
      await ds.query(`UPDATE jobs SET status = 'queued' WHERE id = $1`, [id]);
      expect(await runner().run(id)).toBe('succeeded');
    }
    return ids.length;
  };
  /** Ends a child run the way the runner does: its jobs reach a final state, then the run status is derived. */
  const finishRun = async (runId: string, status: 'succeeded' | 'dead') => {
    await ds.transaction(async (em) => {
      await em.query(`UPDATE jobs SET status = $2, finished_at = now() WHERE workflow_run_id = $1`, [
        runId,
        status,
      ]);
      await refreshRunStatus(em, runId);
    });
  };
  const childRun = async (kind: string, sourceId: string): Promise<string> => {
    const rows: { id: string }[] = await ds.query(
      `SELECT id FROM workflow_runs WHERE merchant_id = $1 AND kind = $2 AND subject_id = $3 ORDER BY created_at DESC LIMIT 1`,
      [m, kind, sourceId],
    );
    expect(rows[0], `${kind} run of ${sourceId}`).toBeDefined();
    return rows[0]?.id as string;
  };
  async function source(opts: { audio: boolean; still?: boolean; transcript?: boolean }): Promise<string> {
    const id = uuidv7();
    const probe = {
      still: !!opts.still,
      durationMs: 60_000,
      video: { width: 1080, height: 1920, fps: { num: 30, den: 1 }, durationFrames: 1800 },
      audio: opts.audio ? { codec: 'aac' } : null,
    };
    await ds.query(
      `INSERT INTO video_sources (id, merchant_id, upload_id, title, original_filename, size_bytes, sha256, status, probe)
       VALUES ($1, $2, $3, 't', 'f', 10, 'x', 'ready', $4)`,
      [id, m, `up-${id}`, JSON.stringify(probe)],
    );
    if (opts.audio)
      await ds.query(
        `INSERT INTO media_assets (merchant_id, source_id, kind, storage_key, size_bytes, sha256, content_type)
         VALUES ($1, $2, 'audio', $3, 1, 'x', 'audio/flac')`,
        [m, id, `k/${id}`],
      );
    if (opts.transcript)
      await ds.query(
        `INSERT INTO transcripts (merchant_id, source_id, audio_sha256, model, engine, recipe_version, status, duration_ms)
         VALUES ($1, $2, 'a', 'm', 'e', 2, 'ready', 60000)`,
        [m, id],
      );
    await ds.query(
      `INSERT INTO project_folder_sources (id, merchant_id, folder_id, source_id) VALUES ($1, $2, $3, $4)`,
      [uuidv7(), m, folder, id],
    );
    return id;
  }

  beforeAll(async () => {
    ds = await freshTestDb();
    m = (
      await seedMerchant(ds, {
        merchantName: 'F',
        merchantSlug: 'fe',
        email: 'f@fe.local',
        password: 'password-fe',
        displayName: 'F',
      })
    ).merchant.id;
    folder = uuidv7();
    await ds.query(
      `INSERT INTO project_folders (id, merchant_id, title, settings) VALUES ($1, $2, 'ไลฟ์', $3)`,
      [folder, m, JSON.stringify({ productName: 'เสื้อมัดย้อม', ratio: '16:9' })],
    );
  });
  afterAll(async () => {
    await ds.destroy();
  });

  it('runs explicitly requested transcription → analyse → (style) → edit by waking on child runs, then closes', async () => {
    const live = await source({ audio: true, transcript: true });
    const raw = await source({ audio: true });
    await source({ audio: false, still: true }); // a photo: prepared, never transcribed
    // The merchant explicitly chose whole-source transcription before submitting this source to the edit.
    await requestTranscription(ds, { merchantId: m, sourceId: raw });

    expect((await folderPlanOf(ds, m, folder)).plan.steps[1]?.state).toBe('pending');
    const { runId, created } = await requestFolderEdit(ds, { merchantId: m, folderId: folder });
    expect(created).toBe(true);
    expect((await requestFolderEdit(ds, { merchantId: m, folderId: folder })).runId).toBe(runId); // joins

    // 1st advance starts analysis; the raw video's separately requested ASR is already running.
    expect(await runAdvance(runId)).toBe(1);
    const analysis = await childRun('live_to_clips', live);
    const [a] = (await ds.query('SELECT input FROM workflow_runs WHERE id = $1', [analysis])) as {
      input: { product: { name?: string } };
    }[];
    expect(a?.input.product.name).toBe('เสื้อมัดย้อม');
    const asr = await childRun('transcribe', raw);
    let plan = (await folderPlanOf(ds, m, folder)).plan;
    expect(plan.steps.map((s) => s.state)).toEqual(['done', 'running', 'running', 'pending', 'pending']);

    // the analysis finishes with one clip planned → the folder edit wakes (outbox job), nothing to build yet
    await ds.query(
      `INSERT INTO clip_suggestions (merchant_id, source_id, workflow_run_id, rank, status, start_ms, end_ms, start_word,
         end_word, score, type, reason, quote, hook, title, origin, mode)
       VALUES ($1, $2, $3, 1, 'planned', 0, 20000, 0, 10, 80, 'faq', 'r', NULL, NULL, 't', 'rules', 'rules')`,
      [m, live, analysis],
    );
    await finishRun(analysis, 'succeeded');
    expect(await pendingAdvance(runId)).toHaveLength(1);
    await runAdvance(runId);

    // ASR of the second video finishes → wake → its analysis starts
    await ds.query(
      `INSERT INTO transcripts (merchant_id, source_id, audio_sha256, model, engine, recipe_version, status, duration_ms)
       VALUES ($1, $2, 'b', 'm', 'e', 2, 'ready', 60000)`,
      [m, raw],
    );
    await finishRun(asr, 'succeeded');
    await runAdvance(runId);
    const analysis2 = await childRun('live_to_clips', raw);
    await finishRun(analysis2, 'succeeded'); // nothing worth cutting in this one
    await runAdvance(runId);

    plan = (await folderPlanOf(ds, m, folder)).plan;
    expect(plan.needs).toBe('style');
    expect(plan.steps[3]?.state).toBe('waiting');

    // merchant picks a style → edit starts only where there is something to edit
    expect(
      await chooseFolderStyle(ds, {
        merchantId: m,
        folderId: folder,
        styleId: 'sale-fast',
        styleIds: ['sale-fast', 'premium'],
      }),
    ).toEqual({
      runId,
    });
    await runAdvance(runId);
    const build = await childRun('build_clips', live);
    // the folder's frame reaches every clip build
    const [b] = (await ds.query('SELECT input FROM workflow_runs WHERE id = $1', [build])) as {
      input: { ratio?: string };
    }[];
    expect(b?.input.ratio).toBe('16:9');
    const [selection] = await ds.query('SELECT input FROM workflow_runs WHERE id=$1', [build]);
    expect(selection.input.styleIds).toEqual(['sale-fast', 'premium']);
    const variants = await ds.query(
      'SELECT rank FROM clip_suggestions WHERE workflow_run_id=$1 ORDER BY rank',
      [analysis],
    );
    expect(variants).toHaveLength(2);
    const jobs = (await ds.query(
      `SELECT payload FROM jobs WHERE workflow_run_id = $1 AND type = 'clips.build'`,
      [build],
    )) as { payload: { ratio?: string } }[];
    expect(jobs.map((j) => j.payload.ratio)).toEqual(['16:9']);
    expect(
      (
        await ds.query('SELECT 1 FROM workflow_runs WHERE kind = $1 AND subject_id = $2', [
          'build_clips',
          raw,
        ])
      ).length,
    ).toBe(0);
    expect((await folderPlanOf(ds, m, folder)).plan.steps[4]?.state).toBe('running');

    await finishRun(build, 'succeeded');
    const montageJobs = (await ds.query(
      `SELECT id FROM jobs WHERE workflow_run_id=$1 AND type='folder.montage'`,
      [runId],
    )) as { id: string }[];
    expect(montageJobs).toHaveLength(2);
    for (const j of montageJobs) {
      await ds.query(`UPDATE jobs SET status='queued' WHERE id=$1`, [j.id]);
      expect(await runner().run(j.id)).toBe('succeeded');
      // Retry reuses the same editable project without opening any media.
      const output = await ds.query(`SELECT result FROM jobs WHERE id=$1`, [j.id]);
      expect(output[0].result.projectId).toBeTruthy();
    }
    await runAdvance(runId);
    plan = (await folderPlanOf(ds, m, folder)).plan;
    expect(plan).toMatchObject({ finished: true, done: 5, total: 5 });
    // closed: a later child run no longer wakes it, and "start" makes a new edit
    const [closed] = (await ds.query('SELECT input FROM workflow_runs WHERE id = $1', [runId])) as {
      input: { closedAt?: string };
    }[];
    expect(closed?.input.closedAt).toBeTruthy();
    expect((await requestFolderEdit(ds, { merchantId: m, folderId: folder })).created).toBe(true);
  });

  it('a failed child run shows as a failed step with a Thai reason and closes the edit', async () => {
    const f2 = uuidv7();
    await ds.query(`INSERT INTO project_folders (id, merchant_id, title) VALUES ($1, $2, 'พัง')`, [f2, m]);
    const prev = folder;
    folder = f2;
    const s = await source({ audio: true });
    folder = prev;
    await requestTranscription(ds, { merchantId: m, sourceId: s });
    const { runId } = await requestFolderEdit(ds, { merchantId: m, folderId: f2 });
    await runAdvance(runId);
    await finishRun(await childRun('transcribe', s), 'dead');
    await runAdvance(runId);
    const plan = (await folderPlanOf(ds, m, f2)).plan;
    expect(plan.failed).toBe(true);
    expect(plan.steps[1]).toMatchObject({ state: 'failed', error: 'ถอดเสียงไม่สำเร็จ 1 วิดีโอ' });
    expect(plan.steps[2]?.state).toBe('pending');
  });

  it('snapshots selected footage and waits for explicit transcription without starting ASR for any upload', async () => {
    const prev = folder;
    folder = uuidv7();
    await ds.query(`INSERT INTO project_folders (id, merchant_id, title) VALUES ($1, $2, 'เลือก')`, [
      folder,
      m,
    ]);
    const selected = await source({ audio: true });
    const excluded = await source({ audio: true });
    const { runId } = await requestFolderEdit(ds, { merchantId: m, folderId: folder, sourceIds: [selected] });
    await source({ audio: true });
    expect((await folderPlanOf(ds, m, folder)).facts.sources.map((s) => s.id)).toEqual([selected]);
    await runAdvance(runId);
    const children = await ds.query(
      `SELECT subject_id FROM workflow_runs WHERE kind = 'transcribe' AND subject_id = ANY($1::uuid[])`,
      [[selected, excluded]],
    );
    expect(children).toEqual([]);
    expect((await folderPlanOf(ds, m, folder)).plan.needs).toBe('transcript');
    await requestTranscription(ds, { merchantId: m, sourceId: selected });
    const chosen = await ds.query(
      `SELECT subject_id FROM workflow_runs WHERE kind='transcribe' AND subject_id=ANY($1::uuid[])`,
      [[selected, excluded]],
    );
    expect(chosen).toEqual([{ subject_id: selected }]);
    folder = prev;
  });

  it('rejects empty, missing and non-member selections without creating a run', async () => {
    const f = uuidv7();
    await ds.query(`INSERT INTO project_folders (id, merchant_id, title) VALUES ($1, $2, 'เลือก')`, [f, m]);
    const outside = await source({ audio: true });
    for (const sourceIds of [[], [uuidv7()], [outside]])
      await expect(requestFolderEdit(ds, { merchantId: m, folderId: f, sourceIds })).rejects.toMatchObject({
        reason: 'invalid_selection',
      });
    expect(
      await ds.query(`SELECT id FROM workflow_runs WHERE kind = 'folder_edit' AND subject_id = $1`, [f]),
    ).toEqual([]);
  });

  it('finishes a folder containing four photos and one silent video with one editable montage', async () => {
    const prev = folder;
    folder = uuidv7();
    await ds.query(`INSERT INTO project_folders(id,merchant_id,title) VALUES($1,$2,'รูปสินค้า')`, [folder, m]);
    for (let i = 0; i < 4; i++) await source({ audio: false, still: true });
    await source({ audio: false });
    const { runId } = await requestFolderEdit(ds, {
      merchantId: m,
      folderId: folder,
      styleId: 'honest-review',
    });
    await runAdvance(runId);
    const [j] = (await ds.query(`SELECT id FROM jobs WHERE workflow_run_id=$1 AND type='folder.montage'`, [
      runId,
    ])) as { id: string }[];
    expect(j).toBeDefined();
    await ds.query(`UPDATE jobs SET status='queued' WHERE id=$1`, [j!.id]);
    expect(await runner().run(j!.id)).toBe('succeeded');
    await runAdvance(runId);
    expect((await folderPlanOf(ds, m, folder)).plan.finished).toBe(true);
    const [version] = await ds.query(
      `SELECT v.doc FROM project_versions v WHERE v.merchant_id=$1 AND v.doc->'meta'->>'workflowRunId'=$2`,
      [m, runId],
    );
    const elements = Object.values(version.doc.elements) as { type: string }[];
    expect(elements.filter((e) => e.type === 'image')).toHaveLength(4);
    expect(elements.filter((e) => e.type === 'video')).toHaveLength(1);
    folder = prev;
  });
});
