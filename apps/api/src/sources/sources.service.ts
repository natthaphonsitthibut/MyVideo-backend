import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import type { SourceList, SourceSummary } from '@myvideo/contracts';
import { extensionOf, type StoragePort, storageKeys } from '@myvideo/domain';
import {
  createRunInTransaction,
  type Env,
  enqueueInTransaction,
  MediaAssetEntity,
  VideoSourceEntity,
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

  private async summaries(sources: VideoSourceEntity[]): Promise<SourceSummary[]> {
    if (sources.length === 0) return [];
    const ids = sources.map((s) => s.id);
    const merchantId = sources[0]?.merchantId ?? '';
    const runs: { id: string; subject_id: string; status: string }[] = await this.ds.query(
      `SELECT DISTINCT ON (subject_id) id, subject_id, status FROM workflow_runs
        WHERE merchant_id = $1 AND kind = 'ingest' AND subject_type = 'source' AND subject_id = ANY($2::uuid[])
        ORDER BY subject_id, created_at DESC`,
      [merchantId, ids],
    );
    const assets = await this.ds.getRepository(MediaAssetEntity).find({
      where: ids.map((id) => ({ merchantId, sourceId: id })),
      select: { sourceId: true, kind: true, meta: true, recipeVersion: true },
    });
    return sources.map((source) => {
      const mine = assets.filter((a) => a.sourceId === source.id);
      const sprites = mine.find((a) => a.kind === 'sprites');
      const run = runs.find((r) => r.subject_id === source.id);
      // The run is the live truth while ingest is not finished: a dead step (even one without a handler) shows
      // as failed, and a retried run shows as processing again.
      const status: SourceSummary['status'] =
        source.status === 'ready'
          ? 'ready'
          : run?.status === 'pending' || run?.status === 'running'
            ? 'processing'
            : run?.status === 'failed' || run?.status === 'cancelled'
              ? 'failed'
              : source.status;
      const probe = source.probe as {
        durationMs?: number;
        video?: {
          width?: number;
          height?: number;
          fps?: { num: number; den: number };
          durationFrames?: number;
        };
        audio?: unknown;
      } | null;
      return {
        id: source.id,
        title: source.title,
        originalFilename: source.originalFilename,
        status,
        sizeBytes: Number(source.sizeBytes),
        failureReason:
          status === 'failed' ? (source.failureReason ?? 'ประมวลผลวิดีโอไม่สำเร็จ ลองใหม่ได้ที่หน้านี้') : null,
        ingestRunId: run?.id ?? null,
        createdAt: source.createdAt.toISOString(),
        durationMs: probe?.durationMs ?? null,
        width: probe?.video?.width ?? null,
        height: probe?.video?.height ?? null,
        hasAudio: probe ? !!probe.audio : null,
        fps: probe?.video?.fps ? { num: probe.video.fps.num, den: probe.video.fps.den } : null,
        durationFrames: probe?.video?.durationFrames ?? null,
        hasProxy: mine.some((a) => a.kind === 'proxy'),
        hasPeaks: mine.some((a) => a.kind === 'peaks'),
        sprites: sprites ? (sprites.meta as SourceSummary['sprites']) : null,
      };
    });
  }

  async list(merchantId: string, limit: number, before?: string): Promise<SourceList> {
    const qb = this.ds
      .getRepository(VideoSourceEntity)
      .createQueryBuilder('s')
      .where('s.merchant_id = :merchantId', { merchantId })
      .orderBy('s.created_at', 'DESC')
      .addOrderBy('s.id', 'DESC')
      .limit(limit + 1);
    if (before) {
      const [at, id] = before.split('|');
      if (at && id && !Number.isNaN(Date.parse(at)))
        qb.andWhere('(s.created_at, s.id) < (:at, :id)', { at: new Date(at), id });
    }
    const rows = await qb.getMany();
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: await this.summaries(page),
      nextCursor: rows.length > limit && last ? `${last.createdAt.toISOString()}|${last.id}` : null,
    };
  }

  private async summary(source: VideoSourceEntity): Promise<SourceSummary> {
    const [s] = await this.summaries([source]);
    if (!s) throw new NotFoundException('Source not found');
    return s;
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
