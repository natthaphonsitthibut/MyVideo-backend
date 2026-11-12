import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStorage, MediaAssetEntity, seedMerchant, VideoSourceEntity } from '@myvideo/infra';
import type { INestApplication } from '@nestjs/common';
import * as tus from 'tus-js-client';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { footageClip } from '../../../test/footage.js';
import { freshTestDb } from '../../../test/test-db.js';
import { testEnv } from '../../../test/test-env.js';
import { createApp } from '../src/app.js';
import { loginCookie } from './helpers.js';

// Real footage locally; CI (no footage) uses random bytes, which only exercises the transport (labelled).
const CLIP = footageClip('talkinghead-th-portrait.mp4');
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
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe(`resumable upload → source + ingest run (${CLIP ? 'real footage' : 'plumbing bytes'})`, () => {
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let cookieA: string;
  let cookieB: string;
  let file: Buffer;
  const scratch = mkdtempSync(join(tmpdir(), 'myvideo-upload-test-'));
  const env = testEnv({
    STORAGE_LOCAL_DIR: join(scratch, 'storage'),
    UPLOAD_TMP_DIR: join(scratch, 'uploads'),
  });

  beforeAll(async () => {
    file = CLIP ? await readFile(CLIP) : Buffer.alloc(6 * 1024 * 1024, 7);
    ds = await freshTestDb();
    await seedMerchant(ds, A);
    await seedMerchant(ds, B);
    app = await createApp(env);
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    cookieA = await loginCookie(app, A.email, A.password);
    cookieB = await loginCookie(app, B.email, B.password);
  });
  afterAll(async () => {
    await app.close();
    await ds.destroy();
    rmSync(scratch, { recursive: true, force: true });
  });

  const startUpload = (
    cookie: string,
    opts: { uploadUrl?: string; onProgress?: (sent: number, total: number, u: tus.Upload) => void } = {},
  ) =>
    new Promise<{ url: string; aborted: boolean }>((resolve, reject) => {
      const u: tus.Upload = new tus.Upload(file, {
        endpoint: `${base}/uploads`,
        uploadUrl: opts.uploadUrl ?? null,
        chunkSize: 512 * 1024,
        retryDelays: [],
        headers: { Cookie: cookie },
        metadata: { filename: 'ไลฟ์ทดสอบ.mp4', filetype: 'video/mp4' },
        onProgress: (sent, total) => opts.onProgress?.(sent, total, u),
        onSuccess: () => resolve({ url: u.url ?? '', aborted: false }),
        onError: reject,
      });
      // let the caller abort mid-way
      (u as unknown as { _resolveAbort: () => void })._resolveAbort = () =>
        resolve({ url: u.url ?? '', aborted: true });
      u.start();
    });

  it('survives an interruption at ~50 %, resumes, and stores a byte-identical original', async () => {
    let sentAtAbort = 0;
    const first = await startUpload(cookieA, {
      onProgress: (sent, total, u) => {
        if (!sentAtAbort && sent / total >= 0.5) {
          sentAtAbort = sent;
          void u.abort().then(() => (u as unknown as { _resolveAbort: () => void })._resolveAbort());
        }
      },
    });
    expect(first.aborted).toBe(true);
    const id = first.url.split('/').pop() ?? '';
    const head = await fetch(first.url, {
      method: 'HEAD',
      headers: { cookie: cookieA, 'tus-resumable': '1.0.0' },
    });
    const offset = Number(head.headers.get('upload-offset'));
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThan(file.length);

    let firstProgressAfterResume = -1;
    await startUpload(cookieA, {
      uploadUrl: first.url,
      onProgress: (sent) => {
        if (firstProgressAfterResume < 0) firstProgressAfterResume = sent;
      },
    });
    expect(firstProgressAfterResume).toBeGreaterThanOrEqual(offset); // continued, did not restart at 0

    const res = await fetch(`${base}/sources/by-upload/${id}`, { headers: { cookie: cookieA } });
    expect(res.status).toBe(200);
    const source = (await res.json()) as {
      id: string;
      status: string;
      sizeBytes: number;
      title: string;
      ingestRunId: string;
    };
    expect(source).toMatchObject({ status: 'processing', sizeBytes: file.length, title: 'ไลฟ์ทดสอบ' });
    const asset = await ds
      .getRepository(MediaAssetEntity)
      .findOneByOrFail({ sourceId: source.id, kind: 'original' });
    expect(asset.sha256).toBe(sha(file));
    const stored = await new LocalStorage(env.STORAGE_LOCAL_DIR).localPath(asset.storageKey);
    expect(sha(await readFile(stored.path))).toBe(sha(file));
    const jobs: { type: string; status: string; queue: string }[] = await ds.query(
      'SELECT type, status, queue FROM jobs WHERE workflow_run_id = $1',
      [source.ingestRunId],
    );
    expect(jobs).toEqual([{ type: 'media.probe', status: 'pending', queue: 'media' }]);

    // authorised streaming with Range (seek support), merchant-scoped
    const part = await fetch(`${base}/sources/${source.id}/assets/original`, {
      headers: { cookie: cookieA, range: 'bytes=1000-1999' },
    });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 1000-1999/${file.length}`);
    expect(Buffer.from(await part.arrayBuffer()).equals(file.subarray(1000, 2000))).toBe(true);
    const bad = await fetch(`${base}/sources/${source.id}/assets/original`, {
      headers: { cookie: cookieA, range: `bytes=${file.length}-` },
    });
    expect(bad.status).toBe(416);
    expect(
      (await fetch(`${base}/sources/${source.id}/assets/original`, { headers: { cookie: cookieB } })).status,
    ).toBe(404);
    expect(
      (await fetch(`${base}/sources/${source.id}/assets/proxy`, { headers: { cookie: cookieA } })).status,
    ).toBe(404);
  });

  it('completing twice (and concurrently) creates one source and one ingest run', async () => {
    const { url } = await startUpload(cookieA);
    const id = url.split('/').pop() ?? '';
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        fetch(`${base}/sources/by-upload/${id}`, { headers: { cookie: cookieA } }).then((r) => r.json()),
      ),
    );
    expect(new Set(results.map((r) => (r as { id: string }).id)).size).toBe(1);
    expect(await ds.getRepository(VideoSourceEntity).countBy({ uploadId: id })).toBe(1);
    const runs: { n: string }[] = await ds.query(
      `SELECT count(*) AS n FROM workflow_runs WHERE subject_id = $1 AND kind = 'ingest'`,
      [(results[0] as { id: string }).id],
    );
    expect(Number(runs[0]?.n)).toBe(1);
  });

  it('lists sources for the owner only, newest first, with what is ready', async () => {
    const mine = (await (
      await fetch(`${base}/sources?limit=50`, { headers: { cookie: cookieA } })
    ).json()) as {
      items: { id: string; status: string; hasProxy: boolean; sprites: unknown; durationMs: number | null }[];
    };
    expect(mine.items.length).toBeGreaterThanOrEqual(2);
    expect(mine.items[0]).toMatchObject({
      status: 'processing',
      hasProxy: false,
      sprites: null,
      durationMs: null,
    });
    const theirs = (await (await fetch(`${base}/sources`, { headers: { cookie: cookieB } })).json()) as {
      items: unknown[];
    };
    expect(theirs.items).toHaveLength(0);
  });

  it('derives the shown status from the ingest run (dead step → failed, retried → processing)', async () => {
    const list = (await (
      await fetch(`${base}/sources?limit=1`, { headers: { cookie: cookieA } })
    ).json()) as { items: { id: string; ingestRunId: string }[] };
    const src = list.items[0];
    await ds.query(`UPDATE jobs SET status = 'dead' WHERE workflow_run_id = $1`, [src?.ingestRunId]);
    await ds.query(`UPDATE workflow_runs SET status = 'failed' WHERE id = $1`, [src?.ingestRunId]);
    const failed = (await (
      await fetch(`${base}/sources/${src?.id}`, { headers: { cookie: cookieA } })
    ).json()) as { status: string; failureReason: string };
    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed.failureReason).toMatch(/ไม่สำเร็จ/);
    await ds.query(`UPDATE workflow_runs SET status = 'running' WHERE id = $1`, [src?.ingestRunId]);
    expect(
      (
        (await (await fetch(`${base}/sources/${src?.id}`, { headers: { cookie: cookieA } })).json()) as {
          status: string;
        }
      ).status,
    ).toBe('processing');
  });

  it('tells the UI the limits', async () => {
    const cfg = (await (
      await fetch(`${base}/sources/upload-config`, { headers: { cookie: cookieA } })
    ).json()) as { extensions: string[] };
    expect(cfg).toMatchObject({
      endpoint: '/uploads',
      maxBytes: env.UPLOAD_MAX_BYTES,
      chunkBytes: 8 * 1024 * 1024,
    });
    expect(cfg.extensions).toContain('mp4');
  });

  it('keeps uploads private to the merchant and rejects bad requests', async () => {
    const { url } = await startUpload(cookieA);
    const id = url.split('/').pop() ?? '';
    const other = await fetch(url, {
      method: 'HEAD',
      headers: { cookie: cookieB, 'tus-resumable': '1.0.0' },
    });
    expect(other.status).toBe(404);
    expect((await fetch(`${base}/sources/by-upload/${id}`, { headers: { cookie: cookieB } })).status).toBe(
      404,
    );
    const anon = await fetch(`${base}/uploads`, {
      method: 'POST',
      headers: { 'tus-resumable': '1.0.0', 'upload-length': '10' },
    });
    expect(anon.status).toBe(401);
    const meta = `filename ${Buffer.from('notes.txt').toString('base64')}`;
    const bad = await fetch(`${base}/uploads`, {
      method: 'POST',
      headers: { cookie: cookieA, 'tus-resumable': '1.0.0', 'upload-length': '10', 'upload-metadata': meta },
    });
    expect(bad.status).toBe(415);
    expect(await bad.text()).toContain('ไม่ใช่วิดีโอที่รองรับ');
    const tooBig = await fetch(`${base}/uploads`, {
      method: 'POST',
      headers: {
        cookie: cookieA,
        'tus-resumable': '1.0.0',
        'upload-length': String(env.UPLOAD_MAX_BYTES + 1),
        'upload-metadata': `filename ${Buffer.from('a.mp4').toString('base64')}`,
      },
    });
    expect(tooBig.status).toBe(413);
  });
});
