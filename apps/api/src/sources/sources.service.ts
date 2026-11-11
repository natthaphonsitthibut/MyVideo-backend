import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import type { SourceSummary } from '@myvideo/contracts';
import { extensionOf, type StoragePort, storageKeys } from '@myvideo/domain';
import {
  createRunInTransaction,
  type Env,
  enqueueInTransaction,
  MediaAssetEntity,
  VideoSourceEntity,
  WorkflowRunEntity,
} from '@myvideo/infra';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { FileStore } from '@tus/file-store';
import { DataSource } from 'typeorm';
import { ENV } from '../config/env.module.js';
import { STORAGE } from '../storage/storage.module.js';

export const TUS_STORE = Symbol('TUS_STORE');

const CONTENT_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
};

@Injectable()
export class SourcesService {
  constructor(
    @Inject(DataSource) private readonly ds: DataSource,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(TUS_STORE) private readonly tusStore: FileStore,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private async summary(source: VideoSourceEntity): Promise<SourceSummary> {
    const run = await this.ds.getRepository(WorkflowRunEntity).findOne({
      where: { merchantId: source.merchantId, subjectType: 'source', subjectId: source.id, kind: 'ingest' },
      order: { createdAt: 'DESC' },
    });
    return {
      id: source.id,
      title: source.title,
      originalFilename: source.originalFilename,
      status: source.status,
      sizeBytes: Number(source.sizeBytes),
      failureReason: source.failureReason,
      ingestRunId: run?.id ?? null,
      createdAt: source.createdAt.toISOString(),
    };
  }

  /** The newest asset of a kind for a source of this merchant (404 when missing). */
  async asset(merchantId: string, sourceId: string, kind: string): Promise<MediaAssetEntity> {
    const a = await this.ds.getRepository(MediaAssetEntity).findOne({
      where: { merchantId, sourceId, kind: kind as MediaAssetEntity['kind'] },
      order: { recipeVersion: 'DESC' },
    });
    if (!a) throw new NotFoundException('File not found');
    return a;
  }

  get store(): StoragePort {
    return this.storage;
  }

  async get(merchantId: string, id: string): Promise<SourceSummary> {
    const s = await this.ds.getRepository(VideoSourceEntity).findOneBy({ id, merchantId });
    if (!s) throw new NotFoundException('Source not found');
    return this.summary(s);
  }

  /**
   * Hand-over of a finished upload (ARCHITECTURE §8): copy the file into storage as the immutable original,
   * then ONE transaction creates the source, its original asset, the ingest run and its first job.
   * Idempotent per upload: a second call (retry, duplicate completion, lazy call from the client) returns the
   * same source. The source id was minted at upload creation, so the storage key is stable across retries.
   */
  async finalizeUpload(merchantId: string, uploadId: string): Promise<SourceSummary> {
    const existing = await this.ds.getRepository(VideoSourceEntity).findOneBy({ merchantId, uploadId });
    if (existing) return this.summary(existing);
    let upload: Awaited<ReturnType<FileStore['getUpload']>>;
    try {
      upload = await this.tusStore.getUpload(uploadId);
    } catch {
      throw new NotFoundException('Upload not found');
    }
    const meta = upload.metadata ?? {};
    if (meta.merchantId !== merchantId) throw new NotFoundException('Upload not found');
    if (upload.size === undefined || upload.offset !== upload.size) {
      throw new ConflictException('Upload is not finished yet');
    }
    const sourceId = String(meta.sourceId);
    const filename = String(meta.filename ?? 'video');
    const ext = extensionOf(filename) || 'bin';
    const key = storageKeys.original(merchantId, sourceId, ext);
    const stored = await this.storage.put(key, createReadStream(join(this.env.UPLOAD_TMP_DIR, uploadId)), {
      contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream',
    });
    await this.ds.transaction(async (em) => {
      const inserted: { id: string }[] = await em.query(
        `INSERT INTO video_sources (id, merchant_id, upload_id, title, original_filename, size_bytes, sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING RETURNING id`,
        [
          sourceId,
          merchantId,
          uploadId,
          filename.replace(/\.[^.]+$/, '').slice(0, 200) || 'วิดีโอ',
          filename.slice(0, 255),
          stored.size,
          stored.sha256,
        ],
      );
      if (inserted.length === 0) return; // a concurrent call finished the hand-over
      await em.getRepository(MediaAssetEntity).insert({
        merchantId,
        sourceId,
        kind: 'original',
        recipeVersion: 1,
        storageKey: key,
        sizeBytes: String(stored.size),
        sha256: stored.sha256,
        contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream',
        meta: {},
      });
      const run = await createRunInTransaction(em, {
        merchantId,
        kind: 'ingest',
        subjectType: 'source',
        subjectId: sourceId,
        input: { sourceId },
      });
      await enqueueInTransaction(em, {
        merchantId,
        workflowRunId: run.id,
        type: 'media.probe',
        queue: 'media',
        idempotencyKey: `ingest:${sourceId}:probe`,
        payload: { sourceId },
        stepIndex: 0,
        maxAttempts: 3,
        timeoutMs: 120_000,
      });
    });
    await this.tusStore.remove(uploadId).catch(() => undefined); // temp parts are no longer needed
    const source = await this.ds.getRepository(VideoSourceEntity).findOneByOrFail({ merchantId, uploadId });
    return this.summary(source);
  }
}
