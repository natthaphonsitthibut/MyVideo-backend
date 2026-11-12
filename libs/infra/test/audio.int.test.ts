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
import { audioHandler } from '../src/media/audio-handler.js';
import { probeHandler } from '../src/media/ingest-handlers.js';
import type { PeaksJson } from '../src/media/peaks.js';
import { probeFile } from '../src/media/probe.js';
import { runProcess } from '../src/process/run-process.js';
import { LocalStorage } from '../src/storage/local-storage.js';

const has = !!footageClip('talkinghead-th-portrait.mp4');

describe.skipIf(!has)('media.audio on real footage', { timeout: 120_000 }, () => {
  let ds: DataSource;
  let merchantId: string;
  let runner: JobRunner;
  const root = mkdtempSync(join(tmpdir(), 'myvideo-audio-'));
  const storage = new LocalStorage(join(root, 'storage'));
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
    runner = new JobRunner(
      ds,
      new HandlerRegistry().register(probeHandler({ ds, storage })).register(audioHandler({ ds, storage })),
      { workerId: 'w' },
    );
  });
  afterAll(async () => {
    await ds.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  /** probe, then run media.audio directly (the proxy step is not needed for this one). */
  async function ingestAudio(path: string) {
    const s = await seedSourceFromFile(ds, storage, merchantId, path);
    await ds.query(`UPDATE jobs SET status = 'queued' WHERE id = $1`, [s.jobId]);
    expect(await runner.run(s.jobId)).toBe('succeeded');
    const run = await ds.getRepository(JobEntity).findOneByOrFail({ id: s.jobId });
    const audioJob = await ds.query(
      `INSERT INTO jobs (merchant_id, workflow_run_id, type, queue, idempotency_key, payload, status, step_index)
       VALUES ($1, $2, 'media.audio', 'media', $3, $4, 'queued', 2) RETURNING id`,
      [merchantId, run.workflowRunId, `test-audio-${s.sourceId}`, JSON.stringify({ sourceId: s.sourceId })],
    );
    expect(await runner.run(audioJob[0].id)).toBe('succeeded');
    const peaksAsset = await ds
      .getRepository(MediaAssetEntity)
      .findOneByOrFail({ sourceId: s.sourceId, kind: 'peaks' });
    const peaks = JSON.parse(
      (await import('node:fs')).readFileSync((await storage.localPath(peaksAsset.storageKey)).path, 'utf8'),
    ) as PeaksJson;
    const flac = await ds.getRepository(MediaAssetEntity).findOneBy({ sourceId: s.sourceId, kind: 'audio' });
    return { s, peaks, flac };
  }

  it('speech clip: 16 kHz mono FLAC + peaks matching the duration', async () => {
    const { peaks, flac } = await ingestAudio(`${FOOTAGE_DIR}/clips/talkinghead-th-portrait.mp4`);
    expect(peaks).toMatchObject({ hasAudio: true, silent: false, durationMs: 54_500 });
    expect(peaks.levels[0]?.max).toHaveLength(5450); // 100 buckets/s × 54.5 s
    expect(Math.max(...(peaks.levels[0]?.max ?? []))).toBeGreaterThan(30);
    expect(flac).not.toBeNull();
    const p = await probeFile((await storage.localPath(flac?.storageKey ?? '')).path);
    // ffprobe of an audio-only FLAC is rejected as "no_video" — check the stream directly instead
    expect(p).toMatchObject({ ok: false, reason: 'no_video' });
    let out = '';
    await runProcess(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_name,sample_rate,channels:format=duration',
        '-of',
        'json',
        (await storage.localPath(flac?.storageKey ?? '')).path,
      ],
      { onStdoutLine: (l) => (out += l) },
    );
    const j = JSON.parse(out);
    expect(j.streams[0]).toMatchObject({ codec_name: 'flac', sample_rate: '16000', channels: 1 });
    expect(Math.abs(Number(j.format.duration) - 54.5)).toBeLessThan(0.1);
  });

  it('clip without an audio stream: flat peaks flagged hasAudio=false, no FLAC, no crash', async () => {
    const { peaks, flac } = await ingestAudio(`${FOOTAGE_DIR}/clips/broll-gpu-unboxing-silent.mp4`);
    expect(peaks).toMatchObject({ hasAudio: false, silent: true, durationMs: 30_000 });
    expect(peaks.levels[0]?.max).toHaveLength(3000);
    expect(flac).toBeNull();
  });

  it('clip with a silent audio track is flagged silent (track derived by muting real footage)', async () => {
    const muted = join(root, 'muted.mp4');
    await runProcess('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-i',
      `${FOOTAGE_DIR}/clips/talkinghead-th-portrait.mp4`,
      '-t',
      '10',
      '-c:v',
      'copy',
      '-af',
      'volume=0',
      '-c:a',
      'aac',
      muted,
    ]);
    const { peaks, flac } = await ingestAudio(muted);
    expect(peaks).toMatchObject({ hasAudio: true, silent: true });
    expect(flac).not.toBeNull();
  });
});
