import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRANSCRIPT_RECIPE } from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAiService } from '../../../test/ai-service.js';
import { FOOTAGE_DIR, footageClip } from '../../../test/footage.js';
import { seedSourceFromFile } from '../../../test/ingest-helpers.js';
import { freshTestDb } from '../../../test/test-db.js';
import { AiServiceClient, AiServiceError } from '../src/ai/ai-service.client.js';
import { requestTranscription, transcribeHandlers } from '../src/ai/transcribe-handlers.js';
import {
  TranscriptChunkEntity,
  TranscriptEntity,
  TranscriptSegmentEntity,
} from '../src/db/entities/index.js';
import { seedMerchant } from '../src/db/seed.js';
import { HandlerRegistry } from '../src/jobs/handlers.js';
import { JobRunner } from '../src/jobs/runner.js';
import { audioHandler } from '../src/media/audio-handler.js';
import { probeHandler } from '../src/media/ingest-handlers.js';
import { LocalStorage } from '../src/storage/local-storage.js';

/** Counts real `/asr` calls so a test can prove which chunks were (not) transcribed again. */
class CountingAi extends AiServiceClient {
  asrCalls = 0;
  /** Answer the next N `/asr` calls with the service's real "busy" reply (409), as when it still runs an orphaned chunk. */
  busyFor = 0;
  override asr(...args: Parameters<AiServiceClient['asr']>) {
    if (this.busyFor > 0) {
      this.busyFor--;
      return Promise.reject(
        new AiServiceError('AI service 409 on /asr: {"detail":"ASR is busy with another chunk"}', 409, false),
      );
    }
    this.asrCalls++;
    return super.asr(...args);
  }
}

const has = !!footageClip('talkinghead-th-portrait.mp4');
const CHUNK_MS = 20_000; // C03 is 54.5 s of continuous speech → 3 chunks

describe.skipIf(!has)('transcribe workflow on real Thai speech (C03)', { timeout: 300_000 }, () => {
  let ds: DataSource;
  let merchantId: string;
  let ai: CountingAi;
  let stopAi: () => void;
  const root = mkdtempSync(join(tmpdir(), 'myvideo-transcribe-'));
  const storage = new LocalStorage(join(root, 'storage'));
  const registry = () => {
    const r = new HandlerRegistry()
      .register(probeHandler({ ds, storage }))
      .register(audioHandler({ ds, storage }));
    for (const h of transcribeHandlers({ ds, storage, ai, maxChunkMs: CHUNK_MS, busyRetryMs: 50 }))
      r.register(h);
    return r;
  };

  beforeAll(async () => {
    process.env.AI_ALLOWED_ROOTS = [root, tmpdir()].join(':');
    const svc = await startAiService(18_000 + Math.floor(Math.random() * 1000));
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
  }, 60_000);
  afterAll(async () => {
    stopAi?.();
    await ds?.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  /** Runs the queued steps of a run in order with one runner, up to `limit` jobs. Returns how many ran. */
  async function drain(runId: string, runner: JobRunner, limit = 100): Promise<number> {
    let n = 0;
    while (n < limit) {
      const [rows]: [{ id: string }[], number] = await ds.query(
        `UPDATE jobs SET status = 'queued' WHERE id = (
           SELECT id FROM jobs WHERE workflow_run_id = $1 AND status IN ('pending', 'queued')
            ORDER BY step_index, created_at, id LIMIT 1) RETURNING id`,
        [runId],
      );
      const id = rows[0]?.id;
      if (!id) return n;
      expect(await runner.run(id)).toBe('succeeded');
      n++;
    }
    return n;
  }

  /** Ingests the clip's audio (probe + audio) and marks the source ready, as the full ingest would. */
  async function readySource(): Promise<string> {
    const s = await seedSourceFromFile(
      ds,
      storage,
      merchantId,
      `${FOOTAGE_DIR}/clips/talkinghead-th-portrait.mp4`,
    );
    const runner = new JobRunner(ds, registry(), { workerId: 'ingest' });
    await ds.query(`UPDATE jobs SET status = 'queued' WHERE id = $1`, [s.jobId]);
    expect(await runner.run(s.jobId)).toBe('succeeded');
    // proxy/sprites are not needed for ASR: run the audio step directly, then drop the rest of ingest
    const audioJob = await ds.query(
      `INSERT INTO jobs (merchant_id, workflow_run_id, type, queue, idempotency_key, payload, status, step_index)
       VALUES ($1, $2, 'media.audio', 'media', $3, $4, 'queued', 2) RETURNING id`,
      [merchantId, s.runId, `t-audio-${s.sourceId}`, JSON.stringify({ sourceId: s.sourceId })],
    );
    expect(await runner.run(audioJob[0].id)).toBe('succeeded');
    await ds.query(`DELETE FROM jobs WHERE workflow_run_id = $1 AND status = 'pending'`, [s.runId]);
    await ds.query(`UPDATE video_sources SET status = 'ready' WHERE id = $1`, [s.sourceId]);
    return s.sourceId;
  }

  async function runStatus(runId: string): Promise<string> {
    return (await ds.query(`SELECT status FROM workflow_runs WHERE id = $1`, [runId]))[0].status;
  }

  let firstSource = '';

  it('VAD → chunks → ASR per chunk → merged, word-timed transcript', async () => {
    firstSource = await readySource();
    const { runId, created } = await requestTranscription(ds, { merchantId, sourceId: firstSource });
    expect(created).toBe(true);
    // asking again while it is unfinished joins the same run
    expect(await requestTranscription(ds, { merchantId, sourceId: firstSource })).toEqual({
      runId,
      created: false,
    });

    const before = ai.asrCalls;
    const ran = await drain(runId, new JobRunner(ds, registry(), { workerId: 'w1' }));
    expect(await runStatus(runId)).toBe('succeeded');

    const t = await ds.getRepository(TranscriptEntity).findOneByOrFail({ sourceId: firstSource });
    expect(t).toMatchObject({
      status: 'ready',
      recipeVersion: TRANSCRIPT_RECIPE,
      language: 'th',
      durationMs: 54_500,
    });
    expect(t.chunkCount).toBeGreaterThanOrEqual(3);
    expect(ran).toBe(t.chunkCount + 3); // plan + one job per chunk + merge + optional spelling
    expect(ai.asrCalls - before).toBe(t.chunkCount);

    const chunks = await ds
      .getRepository(TranscriptChunkEntity)
      .find({ where: { transcriptId: t.id }, order: { chunkIndex: 'ASC' } });
    for (const c of chunks) expect(c.endMs - c.startMs).toBeLessThanOrEqual(CHUNK_MS);

    const segs = await ds
      .getRepository(TranscriptSegmentEntity)
      .find({ where: { transcriptId: t.id }, order: { seq: 'ASC' } });
    expect(segs.length).toBeGreaterThanOrEqual(5);
    let prevEnd = 0;
    for (const s of segs) {
      // ordered across chunk borders (offsets applied), inside the file
      expect(s.startMs).toBeGreaterThanOrEqual(prevEnd - 1);
      expect(s.endMs).toBeLessThanOrEqual(54_500);
      prevEnd = s.endMs;
      for (const w of s.words) {
        expect(w.startMs).toBeGreaterThanOrEqual(s.startMs);
        expect(w.endMs).toBeLessThanOrEqual(s.endMs);
      }
    }
    // later chunks really were shifted: some segment starts after the first chunk
    expect(segs.some((s) => s.startMs >= (chunks[1]?.startMs ?? Number.POSITIVE_INFINITY))).toBe(true);
    expect(segs.map((s) => s.text).join('')).toMatch(/[฀-๿]/);

    // original ASR JSON is in storage and matches the rows
    expect(t.storageKey).toBeTruthy();
    const original = JSON.parse(readFileSync((await storage.localPath(t.storageKey ?? '')).path, 'utf8'));
    expect(original).toMatchObject({ version: 1, model: t.model, audioSha256: t.audioSha256 });
    expect(original.segments).toHaveLength(segs.length);
  });

  it('same audio again → cache hit: no VAD/ASR chunk work, same transcript', async () => {
    const before = ai.asrCalls;
    const { runId, created } = await requestTranscription(ds, { merchantId, sourceId: firstSource });
    expect(created).toBe(true);
    expect(await drain(runId, new JobRunner(ds, registry(), { workerId: 'w2' }))).toBe(2); // cached plan + optional spelling
    const plan = (
      await ds.query(`SELECT result FROM jobs WHERE workflow_run_id = $1 AND type = 'asr.plan'`, [runId])
    )[0].result;
    expect(plan).toMatchObject({ cached: true });
    expect(ai.asrCalls).toBe(before);
    expect(await ds.getRepository(TranscriptEntity).countBy({ sourceId: firstSource })).toBe(1);
  });

  it('worker dies after some chunks → the rest resumes, done chunks are not transcribed again', async () => {
    const sourceId = await readySource();
    const { runId } = await requestTranscription(ds, { merchantId, sourceId });
    // first worker: plan + first chunk, then it "dies" (stops taking jobs)
    expect(await drain(runId, new JobRunner(ds, registry(), { workerId: 'dies' }), 2)).toBe(2);
    const t = await ds.getRepository(TranscriptEntity).findOneByOrFail({ sourceId });
    const doneBefore = await ds
      .getRepository(TranscriptChunkEntity)
      .findBy({ transcriptId: t.id, status: 'done' });
    expect(doneBefore).toHaveLength(1);

    // the run is abandoned (cancelled); a new request resumes the same transcript
    await ds.query(
      `UPDATE jobs SET status = 'cancelled' WHERE workflow_run_id = $1 AND status IN ('pending', 'queued')`,
      [runId],
    );
    await ds.query(`UPDATE workflow_runs SET status = 'cancelled' WHERE id = $1`, [runId]);
    const again = await requestTranscription(ds, { merchantId, sourceId });
    expect(again.created).toBe(true);

    const before = ai.asrCalls;
    // the AI service is still busy with the dead worker's chunk for a while: waiting must not spend attempts
    ai.busyFor = 3;
    await drain(again.runId, new JobRunner(ds, registry(), { workerId: 'w3' }));
    expect(await runStatus(again.runId)).toBe('succeeded');
    expect(ai.busyFor).toBe(0);
    const attempts: { attempts: number }[] = await ds.query(
      `SELECT attempts FROM jobs WHERE workflow_run_id = $1 AND type = 'asr.chunk'`,
      [again.runId],
    );
    expect(attempts.map((a) => a.attempts)).toEqual(attempts.map(() => 1));
    const plan = (
      await ds.query(`SELECT result FROM jobs WHERE workflow_run_id = $1 AND type = 'asr.plan'`, [
        again.runId,
      ])
    )[0].result;
    expect(plan).toMatchObject({ resumed: true });
    expect(plan.pending).not.toContain(doneBefore[0]?.chunkIndex);
    expect(plan.pending).toHaveLength(t.chunkCount - 1);
    expect(ai.asrCalls - before).toBe(t.chunkCount - 1);
    const done = await ds.getRepository(TranscriptEntity).findOneByOrFail({ id: t.id });
    expect(done.status).toBe('ready');
    expect(
      await ds.getRepository(TranscriptSegmentEntity).countBy({ transcriptId: t.id }),
    ).toBeGreaterThanOrEqual(5);
  });

  it('a source without audio cannot be transcribed', async () => {
    const silent = footageClip('broll-gpu-unboxing-silent.mp4');
    if (!silent) return;
    const s = await seedSourceFromFile(ds, storage, merchantId, silent);
    await ds.query(`UPDATE video_sources SET status = 'ready' WHERE id = $1`, [s.sourceId]);
    await expect(requestTranscription(ds, { merchantId, sourceId: s.sourceId })).rejects.toMatchObject({
      reason: 'no_audio',
    });
  });

  it('another merchant cannot start a transcription of this source', async () => {
    const other = (
      await seedMerchant(ds, {
        merchantName: 'B',
        merchantSlug: 'shop-b',
        email: 'b@b.local',
        password: 'password-b',
        displayName: 'B',
      })
    ).merchant.id;
    await expect(
      requestTranscription(ds, { merchantId: other, sourceId: firstSource }),
    ).rejects.toMatchObject({
      reason: 'not_found',
    });
  });
});
