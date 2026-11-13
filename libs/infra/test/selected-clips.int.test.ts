import { uuidv7 } from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { freshTestDb } from '../../../test/test-db.js';
import { requestSelectedClips } from '../src/ai/selected-clips.js';
import { requestTranscription } from '../src/ai/transcribe-handlers.js';
import { seedMerchant } from '../src/db/seed.js';

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
  expect(jobs.every((j: { type: string }) => j.type === 'asr.selected-clip')).toBe(true);
  expect(await ds.query(`SELECT id FROM transcripts WHERE source_id = $1`, [sourceId])).toEqual([]);
  // Manual ranges must not be mistaken for an already-running full-source transcription.
  const full = await requestTranscription(ds, { merchantId, sourceId });
  expect(full.created).toBe(true);
  expect(full.runId).not.toBe(id);
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
