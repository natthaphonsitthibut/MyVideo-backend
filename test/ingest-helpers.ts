import { readFile } from 'node:fs/promises';
import { storageKeys, uuidv7 } from '@myvideo/domain';
import {
  createRunInTransaction,
  enqueueInTransaction,
  type LocalStorage,
  MediaAssetEntity,
} from '@myvideo/infra';
import type { DataSource } from 'typeorm';

/** Creates a source exactly as the upload hand-over does, from a local file, and returns ids. */
export async function seedSourceFromFile(
  ds: DataSource,
  storage: LocalStorage,
  merchantId: string,
  path: string,
) {
  const sourceId = uuidv7();
  const ext = path.split('.').pop() ?? 'bin';
  const key = storageKeys.original(merchantId, sourceId, ext);
  const stored = await storage.put(key, await readFile(path));
  return ds.transaction(async (em) => {
    await em.query(
      `INSERT INTO video_sources (id, merchant_id, upload_id, title, original_filename, size_bytes, sha256)
       VALUES ($1, $2, $3, 'test', $4, $5, $6)`,
      [sourceId, merchantId, `up-${sourceId}`, path.split('/').pop(), stored.size, stored.sha256],
    );
    await em.getRepository(MediaAssetEntity).insert({
      merchantId,
      sourceId,
      kind: 'original',
      recipeVersion: 1,
      storageKey: key,
      sizeBytes: String(stored.size),
      sha256: stored.sha256,
      contentType: 'video/mp4',
      meta: {},
    });
    const run = await createRunInTransaction(em, {
      merchantId,
      kind: 'ingest',
      subjectType: 'source',
      subjectId: sourceId,
    });
    const { job } = await enqueueInTransaction(em, {
      merchantId,
      workflowRunId: run.id,
      type: 'media.probe',
      queue: 'media',
      idempotencyKey: `ingest:${sourceId}:probe`,
      payload: { sourceId },
    });
    return { sourceId, runId: run.id, jobId: job.id };
  });
}
