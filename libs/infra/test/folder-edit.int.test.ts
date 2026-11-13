import { uuidv7 } from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshTestDb } from '../../../test/test-db.js';
import { seedMerchant } from '../src/db/seed.js';
import {
  chooseFolderStyle,
  folderAdvanceHandler,
  folderPlanOf,
  requestFolderEdit,
} from '../src/folders/folder-edit.js';
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
    new JobRunner(ds, new HandlerRegistry().register(folderAdvanceHandler({ ds })), { workerId: 'fe' });
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
    const probe = { still: !!opts.still, durationMs: 60_000, audio: opts.audio ? { codec: 'aac' } : null };
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
      [folder, m, JSON.stringify({ productName: 'เสื้อมัดย้อม' })],
    );
  });
  afterAll(async () => {
    await ds.destroy();
  });

  it('runs transcribe → analyse → (style) → edit by waking on child runs, then closes', async () => {
    const live = await source({ audio: true, transcript: true });
    const raw = await source({ audio: true });
    await source({ audio: false, still: true }); // a photo: prepared, never transcribed

    expect((await folderPlanOf(ds, m, folder)).plan.steps[1]?.state).toBe('pending');
    const { runId, created } = await requestFolderEdit(ds, { merchantId: m, folderId: folder });
    expect(created).toBe(true);
    expect((await requestFolderEdit(ds, { merchantId: m, folderId: folder })).runId).toBe(runId); // joins

    // 1st advance: the transcribed video goes to analysis (with the merchant's product name), the other to ASR
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
    expect(await chooseFolderStyle(ds, { merchantId: m, folderId: folder, styleId: 'sale-fast' })).toEqual({
      runId,
    });
    await runAdvance(runId);
    const build = await childRun('build_clips', live);
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
    const { runId } = await requestFolderEdit(ds, { merchantId: m, folderId: f2 });
    await runAdvance(runId);
    await finishRun(await childRun('transcribe', s), 'dead');
    await runAdvance(runId);
    const plan = (await folderPlanOf(ds, m, f2)).plan;
    expect(plan.failed).toBe(true);
    expect(plan.steps[1]).toMatchObject({ state: 'failed', error: 'ถอดเสียงไม่สำเร็จ 1 วิดีโอ' });
    expect(plan.steps[2]?.state).toBe('pending');
  });
});
