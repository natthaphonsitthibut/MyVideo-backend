import { uuidv7 } from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { freshTestDb } from '../../../test/test-db.js';
import recorded from '../../domain/src/highlights/fixtures/s01-0400-0800.json' with { type: 'json' };
import { requestSelectedClips } from '../src/ai/selected-clips.js';
import { saveSelectedSource } from '../src/ai/selected-source.js';
import { requestTranscription } from '../src/ai/transcribe-handlers.js';
import { seedMerchant } from '../src/db/seed.js';
import { requestLiveToClips } from '../src/highlights/live-to-clips.js';

// Database/queue planning only. Never opens media, calls ASR or calls an LLM.
let ds: DataSource;
let merchantId: string;
const sourceId = uuidv7();
beforeAll(async () => {
  ds = await freshTestDb();
  merchantId = (
    await seedMerchant(ds, {
      merchantName: 'Ranges',
      merchantSlug: 'ranges',
      email: 'ranges@test.local',
      password: 'test-password',
      displayName: 'Ranges',
    })
  ).merchant.id;
  await ds.query(
    `INSERT INTO video_sources (id, merchant_id, upload_id, title, original_filename, size_bytes, sha256, status, probe) VALUES ($1,$2,$3,'Ranges','input.mp4',1,'hash','ready',$4)`,
    [sourceId, merchantId, uuidv7(), JSON.stringify({ durationMs: 60000, audio: { codec: 'aac' } })],
  );
  await ds.query(
    `INSERT INTO media_assets (merchant_id, source_id, kind, storage_key, size_bytes, sha256, content_type) VALUES ($1,$2,'audio','audio',1,'hash','audio/flac')`,
    [merchantId, sourceId],
  );
});
afterAll(async () => {
  await ds.destroy();
});

it('creates one durable job and stable output id per range; HTTP retries join without duplicate clips', async () => {
  const input = {
    merchantId,
    sourceId,
    requestId: uuidv7(),
    ranges: [
      { startMs: 40000, endMs: 50000 },
      { startMs: 5000, endMs: 15000 },
    ],
  };
  const id = await requestSelectedClips(ds, input);
  expect(await requestSelectedClips(ds, input)).toBe(id);
  const jobs = await ds.query(
    `SELECT type, payload FROM jobs WHERE workflow_run_id = $1 ORDER BY (payload->>'startMs')::int`,
    [id],
  );
  expect(jobs).toHaveLength(2);
  expect(
    jobs.map((j: { payload: { startMs: number; endMs: number } }) => [j.payload.startMs, j.payload.endMs]),
  ).toEqual([
    [5000, 15000],
    [40000, 50000],
  ]);
  expect(new Set(jobs.map((j: { payload: { projectId: string } }) => j.payload.projectId)).size).toBe(2);
  expect(new Set(jobs.map((j: { payload: { clipSourceId: string } }) => j.payload.clipSourceId)).size).toBe(
    2,
  );
  expect(jobs.every((j: { type: string }) => j.type === 'asr.selected-clip')).toBe(true);
  expect(await ds.query(`SELECT id FROM transcripts WHERE source_id = $1`, [sourceId])).toEqual([]);
  // Manual ranges must not be mistaken for an already-running full-source transcription.
  const full = await requestTranscription(ds, { merchantId, sourceId });
  expect(full.created).toBe(true);
  expect(full.runId).not.toBe(id);
});

it('makes a selected video reusable as independent footage, with zero-based transcript and idempotent ingest', async () => {
  const id = uuidv7(),
    s = recorded.segments[0]!;
  const input = {
    merchantId,
    sourceId: id,
    parentSourceId: sourceId,
    title: 'Selected range',
    startMs: 5000,
    endMs: 15000,
    video: { key: 'selected.mp4', size: 100, sha256: 'plumbing-only' },
    audio: { key: 'selected.wav', size: 100, sha256: 'plumbing-only-audio' },
    asrKey: 'selected.json',
    asr: {
      language: 'th',
      duration_ms: 10000,
      model: recorded.transcriptModel,
      engine: 'whisper.cpp',
      elapsed_ms: 0,
      segments: [
        {
          start_ms: 0,
          end_ms: s.endMs - s.startMs,
          text: s.text,
          words: s.words.map((w) => ({
            text: w.text,
            kind: w.kind,
            start_ms: w.startMs - s.startMs,
            end_ms: w.endMs - s.startMs,
          })),
          avg_logprob: null,
          no_speech_prob: null,
        },
      ],
    },
  };
  await ds.transaction((em) => saveSelectedSource(em, input));
  await ds.transaction((em) => saveSelectedSource(em, input));
  const [src] = await ds.query('SELECT status FROM video_sources WHERE id=$1 AND merchant_id=$2', [
    id,
    merchantId,
  ]);
  expect(src.status).toBe('processing');
  const transcripts = await ds.query('SELECT id,status,duration_ms FROM transcripts WHERE source_id=$1', [
    id,
  ]);
  expect(transcripts).toHaveLength(1);
  expect(transcripts[0]).toMatchObject({ status: 'ready', duration_ms: 10000 });
  const [segment] = await ds.query('SELECT words FROM transcript_segments WHERE transcript_id=$1', [
    transcripts[0].id,
  ]);
  expect(segment.words[0].startMs).toBe(0);
  expect(await ds.query("SELECT type FROM jobs WHERE payload->>'sourceId'=$1", [id])).toEqual([
    { type: 'media.probe' },
  ]);
});

it('rejects foreign sources and out-of-bounds/overlapping ranges before enqueueing', async () => {
  await expect(
    requestSelectedClips(ds, {
      merchantId: uuidv7(),
      sourceId,
      requestId: uuidv7(),
      ranges: [{ startMs: 0, endMs: 1000 }],
    }),
  ).rejects.toMatchObject({ reason: 'not_found' });
  const before = await ds.query(`SELECT count(*)::int AS n FROM workflow_runs`);
  for (const ranges of [
    [{ startMs: 50000, endMs: 70000 }],
    [
      { startMs: 0, endMs: 2000 },
      { startMs: 1000, endMs: 3000 },
    ],
  ])
    await expect(
      requestSelectedClips(ds, { merchantId, sourceId, requestId: uuidv7(), ranges }),
    ).rejects.toMatchObject({ reason: 'invalid_range' });
  expect(await ds.query(`SELECT count(*)::int AS n FROM workflow_runs`)).toEqual(before);
});

it('starts long-video analysis from the complete transcript before scheduling image work', async () => {
  await ds.query(`UPDATE video_sources SET probe=probe||'{"durationMs":600000}'::jsonb WHERE id=$1`, [
    sourceId,
  ]);
  await ds.query(
    `INSERT INTO transcripts(merchant_id,source_id,audio_sha256,model,engine,recipe_version,status,duration_ms) VALUES($1,$2,'ready-hash','recorded','recorded',1,'ready',600000)`,
    [merchantId, sourceId],
  );
  const run = await requestLiveToClips(ds, { merchantId, sourceId });
  const jobs = await ds.query('SELECT type FROM jobs WHERE workflow_run_id=$1', [run.runId]);
  expect(jobs).toEqual([{ type: 'clips.plan' }]);
});
