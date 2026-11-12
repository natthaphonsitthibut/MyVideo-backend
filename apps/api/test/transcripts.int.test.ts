import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import type {
  ApiErrorBody,
  TranscriptSegment,
  TranscriptSegmentPage,
  TranscriptState,
} from '@myvideo/contracts';
import { storageKeys, uuidv7 } from '@myvideo/domain';
import {
  LocalStorage,
  seedMerchant,
  TranscriptEditEntity,
  TranscriptEntity,
  TranscriptSegmentEntity,
} from '@myvideo/infra';
import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshTestDb } from '../../../test/test-db.js';
import { testEnv } from '../../../test/test-env.js';
import { createApp } from '../src/app.js';
import { loginCookie } from './helpers.js';

const A = {
  merchantName: 'A',
  merchantSlug: 'shop-a',
  email: 'a@a.local',
  password: 'password-a',
  displayName: 'A',
};
const B = {
  merchantName: 'B',
  merchantSlug: 'shop-b',
  email: 'b@b.local',
  password: 'password-b',
  displayName: 'B',
};

/** Recorded real whisper.cpp output of C03 (provenance in the fixture), used as stored transcript text. */
const FIXTURE = JSON.parse(
  readFileSync(new URL('../../../services/ai/tests/fixtures/asr-real.json', import.meta.url), 'utf8'),
)['talkinghead-th-portrait'] as { segments: { start_ms: number; end_ms: number; text: string }[] };

describe('transcript API (real Postgres)', () => {
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let cookieA: string;
  let cookieB: string;
  let merchantA: string;

  beforeAll(async () => {
    ds = await freshTestDb();
    merchantA = (await seedMerchant(ds, A)).merchant.id;
    await seedMerchant(ds, B);
    app = await createApp(testEnv());
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    cookieA = await loginCookie(app, A.email, A.password);
    cookieB = await loginCookie(app, B.email, B.password);
  });
  afterAll(async () => {
    await app.close();
    await ds.destroy();
  });

  const api = (path: string, cookie: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { cookie, origin: base, ...init.headers } });

  async function source(opts: { status: 'processing' | 'ready'; audio: boolean }): Promise<string> {
    const id = uuidv7();
    await ds.query(
      `INSERT INTO video_sources (id, merchant_id, upload_id, title, original_filename, size_bytes, sha256, status)
       VALUES ($1, $2, $3, 't', 't.mp4', 10, 'x', $4)`,
      [id, merchantA, `up-${id}`, opts.status],
    );
    if (opts.audio) {
      await ds.query(
        `INSERT INTO media_assets (merchant_id, source_id, kind, storage_key, size_bytes, sha256, content_type)
         VALUES ($1, $2, 'audio', $3, 10, 'audiosha', 'audio/flac')`,
        [merchantA, id, `m/${merchantA}/sources/${id}/derived/a/audio-v1.flac`],
      );
    }
    return id;
  }

  it('state is `none` before anything ran; another merchant gets 404', async () => {
    const id = await source({ status: 'ready', audio: true });
    const res = await api(`/sources/${id}/transcript`, cookieA);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'none',
      transcriptId: null,
      runId: null,
      segmentCount: 0,
    });
    expect((await api(`/sources/${id}/transcript`, cookieB)).status).toBe(404);
    expect((await api(`/sources/${id}/transcript`, cookieB, { method: 'POST' })).status).toBe(404);
  });

  it('start: 202 with a run, idempotent while unfinished', async () => {
    const id = await source({ status: 'ready', audio: true });
    const first = await api(`/sources/${id}/transcript`, cookieA, { method: 'POST' });
    expect(first.status).toBe(202);
    const a = (await first.json()) as TranscriptState;
    expect(a).toMatchObject({ status: 'running' });
    expect(a.runId).toBeTruthy();
    const second = (await (
      await api(`/sources/${id}/transcript`, cookieA, { method: 'POST' })
    ).json()) as TranscriptState;
    expect(second.runId).toBe(a.runId);
    const job = await ds.query(`SELECT type, queue FROM jobs WHERE workflow_run_id = $1`, [a.runId]);
    expect(job).toEqual([{ type: 'asr.plan', queue: 'ai' }]);
  });

  it('start: 409 with a Thai reason when the source is not ready or has no audio', async () => {
    const processing = await source({ status: 'processing', audio: false });
    const r1 = await api(`/sources/${processing}/transcript`, cookieA, { method: 'POST' });
    expect(r1.status).toBe(409);
    expect(((await r1.json()) as ApiErrorBody).message).toMatch(/ยังเตรียมไม่เสร็จ/);
    const silent = await source({ status: 'ready', audio: false });
    const r2 = await api(`/sources/${silent}/transcript`, cookieA, { method: 'POST' });
    expect(r2.status).toBe(409);
    expect(((await r2.json()) as ApiErrorBody).message).toMatch(/ไม่มีเสียง/);
  });

  it('segments: ordered pages by seq with words; 404 before ready and for another merchant', async () => {
    const id = await source({ status: 'ready', audio: true });
    expect((await api(`/sources/${id}/transcript/segments`, cookieA)).status).toBe(404);
    const t = await ds.getRepository(TranscriptEntity).save({
      merchantId: merchantA,
      sourceId: id,
      audioSha256: 'audiosha',
      model: 'ggml-large-v3-turbo-q5_0.bin',
      engine: 'whisper.cpp',
      recipeVersion: 1,
      status: 'ready',
      durationMs: 54_500,
      chunkCount: 1,
      language: 'th',
    });
    await ds.getRepository(TranscriptSegmentEntity).insert(
      FIXTURE.segments.map((s, seq) => ({
        merchantId: merchantA,
        transcriptId: t.id,
        seq,
        startMs: s.start_ms,
        endMs: s.end_ms,
        text: s.text,
        words: [{ text: s.text, startMs: s.start_ms, endMs: s.end_ms, kind: 'word' }],
      })),
    );
    const total = FIXTURE.segments.length;

    const p1 = (await (
      await api(`/sources/${id}/transcript/segments?limit=8`, cookieA)
    ).json()) as TranscriptSegmentPage;
    expect(p1).toMatchObject({ transcriptId: t.id, total, nextFrom: 8 });
    expect(p1.items.map((s) => s.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(p1.items[0]).toEqual({
      seq: 0,
      startMs: FIXTURE.segments[0]?.start_ms,
      endMs: FIXTURE.segments[0]?.end_ms,
      text: FIXTURE.segments[0]?.text,
      words: [
        {
          text: FIXTURE.segments[0]?.text,
          startMs: FIXTURE.segments[0]?.start_ms,
          endMs: FIXTURE.segments[0]?.end_ms,
          kind: 'word',
          original: null,
        },
      ],
    });
    const all = [...p1.items];
    let from: number | null = p1.nextFrom;
    while (from !== null) {
      const page = (await (
        await api(`/sources/${id}/transcript/segments?limit=8&from=${from}`, cookieA)
      ).json()) as TranscriptSegmentPage;
      all.push(...page.items);
      from = page.nextFrom;
    }
    expect(all).toHaveLength(total);

    const state = await (await api(`/sources/${id}/transcript`, cookieA)).json();
    expect(state).toMatchObject({ status: 'ready', segmentCount: total, language: 'th', durationMs: 54_500 });
    expect((await api(`/sources/${id}/transcript/segments`, cookieB)).status).toBe(404);
    expect((await api(`/sources/${id}/transcript/segments?limit=5000`, cookieA)).status).toBe(400);
  });

  it('word correction: stored as a user layer, survives reload, revertable; ASR rows and stored JSON untouched', async () => {
    const id = await source({ status: 'ready', audio: true });
    const t = await ds.getRepository(TranscriptEntity).save({
      merchantId: merchantA,
      sourceId: id,
      audioSha256: 'audiosha',
      model: 'ggml-large-v3-turbo-q5_0.bin',
      engine: 'whisper.cpp',
      recipeVersion: 1,
      status: 'ready',
      durationMs: 54_500,
      chunkCount: 1,
      language: 'th',
    });
    // real recorded C03 segment 5: "ก็คือคุณทำไลฟ์สดครั้งแรก" split into display words
    const seg = FIXTURE.segments[5];
    if (!seg) throw new Error('fixture');
    const words = [
      { text: 'ก็คือ', startMs: seg.start_ms, endMs: seg.start_ms + 400, kind: 'word' },
      { text: 'คุณ', startMs: seg.start_ms + 400, endMs: seg.start_ms + 700, kind: 'word' },
      { text: 'ทำไลฟสด', startMs: seg.start_ms + 700, endMs: seg.end_ms, kind: 'word' },
    ];
    await ds
      .getRepository(TranscriptSegmentEntity)
      .insert({
        merchantId: merchantA,
        transcriptId: t.id,
        seq: 0,
        startMs: seg.start_ms,
        endMs: seg.end_ms,
        text: 'ก็คือคุณทำไลฟสด',
        words,
      });
    // the merged original ASR JSON as the merge step stores it
    const storage = new LocalStorage(resolve(testEnv().STORAGE_LOCAL_DIR));
    const key = storageKeys.derived(merchantA, id, t.id, 'transcript', 1, 'json');
    const original = await storage.put(
      key,
      Buffer.from(JSON.stringify({ version: 1, segments: [{ text: 'ก็คือคุณทำไลฟสด', words }] })),
    );
    await ds.getRepository(TranscriptEntity).update({ id: t.id }, { storageKey: key });
    const rowsBefore = await ds.query(
      `SELECT text, words FROM transcript_segments WHERE transcript_id = $1`,
      [t.id],
    );

    const put = (path: string, cookie: string, text: unknown) =>
      api(path, cookie, {
        method: 'PUT',
        body: JSON.stringify({ text }),
        headers: { 'content-type': 'application/json' },
      });
    const wordPath = `/sources/${id}/transcript/words/0/2`;

    const res = await put(wordPath, cookieA, '  ทำไลฟ์สด ');
    expect(res.status).toBe(200);
    const edited = (await res.json()) as TranscriptSegment;
    expect(edited.words[2]).toEqual({ ...words[2], text: 'ทำไลฟ์สด', original: 'ทำไลฟสด' });
    expect(edited.text).toBe('ก็คือคุณทำไลฟ์สด');
    expect(edited.words[0]?.original).toBeNull();

    // "reload": a fresh read of the page has the correction
    const page = (await (
      await api(`/sources/${id}/transcript/segments`, cookieA)
    ).json()) as TranscriptSegmentPage;
    expect(page.items[0]?.words[2]).toMatchObject({
      text: 'ทำไลฟ์สด',
      original: 'ทำไลฟสด',
      startMs: words[2]?.startMs,
    });

    // editing again replaces the correction (one row per word)
    expect((await put(wordPath, cookieA, 'ทำไลฟ์สดๆ')).status).toBe(200);
    expect(await ds.getRepository(TranscriptEditEntity).countBy({ transcriptId: t.id })).toBe(1);

    // invalid input, unknown word, other merchant
    expect((await put(wordPath, cookieA, '   ')).status).toBe(400);
    expect((await put(wordPath, cookieA, 'x'.repeat(201))).status).toBe(400);
    expect((await put(`/sources/${id}/transcript/words/0/3`, cookieA, 'x')).status).toBe(404);
    expect((await put(`/sources/${id}/transcript/words/9/0`, cookieA, 'x')).status).toBe(404);
    expect((await put(wordPath, cookieB, 'hack')).status).toBe(404);

    // the ASR original is never touched: segment rows and the stored JSON are byte-identical
    expect(
      await ds.query(`SELECT text, words FROM transcript_segments WHERE transcript_id = $1`, [t.id]),
    ).toEqual(rowsBefore);
    const file = await storage.localPath(key);
    expect(createHash('sha256').update(readFileSync(file.path)).digest('hex')).toBe(original.sha256);

    // revert → back to the recognised word
    const rev = await api(wordPath, cookieA, { method: 'DELETE' });
    expect(rev.status).toBe(200);
    expect(((await rev.json()) as TranscriptSegment).words[2]).toEqual({ ...words[2], original: null });
    expect(await ds.getRepository(TranscriptEditEntity).countBy({ transcriptId: t.id })).toBe(0);
    // writing the recognised text itself stores no correction
    expect((await put(wordPath, cookieA, 'ทำไลฟสด')).status).toBe(200);
    expect(await ds.getRepository(TranscriptEditEntity).countBy({ transcriptId: t.id })).toBe(0);
    await storage.delete(key);
  });
});
