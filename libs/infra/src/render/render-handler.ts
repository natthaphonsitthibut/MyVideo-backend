import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { validateProject } from '@myvideo/contracts';
import {
  checkRenderOutput,
  type RenderProject,
  type StoragePort,
  storageKeys,
  type VideoRenderer,
} from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import { BrandKitEntity } from '../db/entities/brand-kit.entity.js';
import { MediaAssetEntity } from '../db/entities/media-asset.entity.js';
import { MusicEntity } from '../db/entities/music.entity.js';
import { ProjectVersionEntity } from '../db/entities/project.entity.js';
import { RenderEntity } from '../db/entities/render.entity.js';
import { FatalJobError, type JobHandler } from '../jobs/handlers.js';
import { probeFile } from '../media/probe.js';
import { withTempDir } from '../process/run-process.js';
import { probeRendered } from './probe-rendered.js';
import { soundLibraryFile } from './sound-library.js';

export type RenderDeps = {
  ds: DataSource;
  storage: StoragePort;
  renderer: VideoRenderer;
  /** Where the product sound library lives (`SOUND_LIBRARY_DIR`, D-026). */
  soundLibraryDir?: string;
};

/**
 * `render.video` on the `render` queue: renders the pinned project version of a `renders` row with the
 * synced stage bundle, validates the MP4, stores it and writes the output columns once (compare-and-set on
 * the pinned version and `output_key IS NULL` — an old or duplicate attempt can never overwrite a result).
 */
export function renderHandler({
  ds,
  storage,
  renderer,
  soundLibraryDir = '.data/library/sounds',
}: RenderDeps): JobHandler {
  return {
    type: 'render.video',
    queue: 'render',
    async run({ job, signal, progress }) {
      const renderId = String(job.payload.renderId ?? '');
      const render = await ds
        .getRepository(RenderEntity)
        .findOneBy({ id: renderId, merchantId: job.merchantId });
      if (!render) throw new FatalJobError(`render ${renderId} not found`);
      if (render.outputKey) return { renderId, outputKey: render.outputKey, reused: true };
      if (render.stageVersion !== renderer.stageVersion)
        throw new FatalJobError(
          `stage changed since this render was requested (${render.stageVersion} → ${renderer.stageVersion})`,
        );
      const version = await ds
        .getRepository(ProjectVersionEntity)
        .findOneBy({ id: render.projectVersionId, merchantId: job.merchantId });
      if (!version) throw new FatalJobError(`project version ${render.projectVersionId} not found`);
      const checked = validateProject(version.doc);
      if (!checked.ok)
        throw new FatalJobError(`invalid project: ${checked.errors.map((e) => e.message).join('; ')}`);
      const project = checked.project as unknown as RenderProject;

      // originals of every asset, owned by this merchant
      const handles: { release(): Promise<void> }[] = [];
      const media: Record<string, string> = {};
      try {
        const kit = await ds.getRepository(BrandKitEntity).findOneBy({ merchantId: job.merchantId });
        const theme = kit
          ? { primary: kit.primaryColor, accent: kit.accentColor, text: kit.textColor, font: kit.font }
          : undefined;
        for (const [assetId, asset] of Object.entries(project.assets)) {
          if ((asset as { brandLogo?: true }).brandLogo) {
            if (!kit?.logoKey) throw new FatalJobError('โปรเจกต์ใช้โลโก้แบรนด์ แต่ร้านยังไม่ได้อัปโหลดโลโก้');
            const file = await storage.localPath(kit.logoKey);
            handles.push(file);
            media[assetId] = file.path;
            continue;
          }
          if (asset.libraryId) {
            const path = soundLibraryFile(soundLibraryDir, asset.libraryId);
            if (!(await stat(path).catch(() => null)))
              throw new FatalJobError(
                `library sound ${asset.libraryId} is not installed (run pnpm library:fetch)`,
              );
            media[assetId] = path;
            continue;
          }
          if (asset.musicId) {
            const music = await ds
              .getRepository(MusicEntity)
              .findOneBy({ id: asset.musicId, merchantId: job.merchantId, status: 'ready' });
            if (!music) throw new FatalJobError('เพลงไม่พร้อมหรือไม่ได้อยู่ในคลังของร้านนี้');
            const file = await storage.localPath(music.storageKey);
            handles.push(file);
            media[assetId] = file.path;
            continue;
          }
          // never query with an undefined column: TypeORM would match any row
          if (!asset.sourceId) throw new FatalJobError(`asset ${assetId} has no source`);
          const original = await ds
            .getRepository(MediaAssetEntity)
            .findOneBy({ sourceId: asset.sourceId, merchantId: job.merchantId, kind: 'original' });
          if (!original) throw new FatalJobError(`source ${asset.sourceId} has no original`);
          const file = await storage.localPath(original.storageKey);
          handles.push(file);
          media[assetId] = file.path;
        }
        return await withTempDir('render-out', async (dir) => {
          const out = join(dir, 'output.mp4');
          const stats = await renderer.render(
            { project, media, preset: render.preset, outPath: out, ...(theme ? { theme } : {}) },
            { signal, onProgress: (v) => void progress(Math.min(0.98, v)) },
          );
          const check = await probeFile(out, { signal });
          if (!check.ok) throw new Error(`render output invalid: ${check.reason}`);
          // validation step: streams, size, frame count, A/V start + length (a mismatch is not retried)
          const problems = checkRenderOutput(await probeRendered(out, signal), {
            width: project.width,
            height: project.height,
            frames: project.durationFrames,
            fps: project.fps,
          });
          if (problems.length) throw new FatalJobError(`render output check failed: ${problems.join('; ')}`);
          const key = storageKeys.render(job.merchantId, render.id, `output-${job.id}.mp4`);
          const stored = await storage.put(key, createReadStream(out), { contentType: 'video/mp4' });
          const meta = {
            width: check.info.video.width,
            height: check.info.video.height,
            fps: check.info.video.fps,
            durationMs: check.info.durationMs,
            hasAudio: !!check.info.audio,
            bytesOnDisk: (await stat(out)).size,
            ...stats,
          };
          const updated: unknown[] = await ds.query(
            `UPDATE renders SET output_key = $4, size_bytes = $5, sha256 = $6, meta = $7, finished_at = now(), updated_at = now()
             WHERE id = $1 AND merchant_id = $2 AND project_version_id = $3 AND output_key IS NULL RETURNING id`,
            [
              render.id,
              job.merchantId,
              render.projectVersionId,
              key,
              stored.size,
              stored.sha256,
              JSON.stringify(meta),
            ],
          );
          if (updated.length === 0) {
            await storage.delete(key); // another attempt already recorded its output
            const winner = await ds.getRepository(RenderEntity).findOneByOrFail({ id: render.id });
            return { renderId, outputKey: winner.outputKey, reused: true };
          }
          await progress(1);
          return { renderId, outputKey: key, sizeBytes: stored.size, ...meta };
        });
      } finally {
        for (const h of handles) await h.release();
      }
    },
  };
}
