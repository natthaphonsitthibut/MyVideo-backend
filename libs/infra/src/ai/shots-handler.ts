import { readFile } from 'node:fs/promises';
import { mergeShotParts, planShotParts, SHOT_PART_MS, SHOTS_RECIPE, type StoragePort } from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import { AnalysisEntity, type AnalysisPart, DetectedShotEntity } from '../db/entities/analysis.entity.js';
import { FatalJobError, type JobHandler } from '../jobs/handlers.js';
import type { ProbeInfo } from '../media/probe.js';
import { loadSource } from '../media/source-helpers.js';
import { withTempDir } from '../process/run-process.js';
import type { AiServiceClient } from './ai-service.client.js';

export type ShotsDeps = { ds: DataSource; storage: StoragePort; ai: AiServiceClient; partMs?: number };

/**
 * `shots.detect` (E07-F05): shot detection + 1–3 keyframes per shot for one source, part by part (5 min) with
 * progress after each part. A finished part is stored on the analysis row before the next starts, so a retry after
 * a crash only redoes unfinished parts. Cached per (source, recipe). Keyframes go to storage as derived files.
 */
export function shotsHandler({ ds, storage, ai, partMs }: ShotsDeps): JobHandler {
  return {
    type: 'shots.detect',
    queue: 'ai',
    async run({ job, signal, progress }) {
      const { source, original } = await loadSource(ds, job);
      const probe = source.probe as ProbeInfo | null;
      if (!probe) throw new FatalJobError('source has no probe result');
      const repo = ds.getRepository(AnalysisEntity);
      const key = {
        merchantId: job.merchantId,
        sourceId: source.id,
        kind: 'shots' as const,
        recipeVersion: SHOTS_RECIPE,
      };
      await ds
        .createQueryBuilder()
        .insert()
        .into(AnalysisEntity)
        .values({
          ...key,
          parts: planShotParts(probe.durationMs, partMs ?? SHOT_PART_MS).map((p) => ({ ...p, done: false })),
        })
        .orIgnore()
        .execute();
      const analysis = await repo.findOneByOrFail(key);
      if (analysis.status === 'ready') return { analysisId: analysis.id, cached: true };
      if (analysis.status === 'failed')
        await repo.update({ id: analysis.id }, { status: 'running', error: null });

      const parts: AnalysisPart[] = analysis.parts;
      const file = await storage.localPath(original.storageKey);
      let engine = analysis.engine;
      try {
        for (const part of parts) {
          if (part.done) continue;
          signal.throwIfAborted();
          const shots = await withTempDir('myvideo-shots-', async (dir) => {
            const r = await ai.shots(file.path, {
              startMs: part.startMs,
              endMs: part.endMs,
              keyframesDir: dir,
              signal,
            });
            engine = r.engine;
            const out: NonNullable<AnalysisPart['shots']> = [];
            for (const s of r.shots) {
              const keyframes: { tMs: number; storageKey: string }[] = [];
              for (const k of s.keyframes) {
                const storageKey = `m/${job.merchantId}/sources/${source.id}/derived/${analysis.id}/kf-v${SHOTS_RECIPE}-${String(k.t_ms).padStart(9, '0')}.jpg`;
                await storage.put(storageKey, await readFile(k.path), { contentType: 'image/jpeg' });
                keyframes.push({ tMs: k.t_ms, storageKey });
              }
              out.push({ startMs: s.start_ms, endMs: s.end_ms, keyframes });
            }
            part.elapsedMs = r.elapsed_ms;
            return out;
          });
          part.shots = shots;
          part.done = true;
          await repo.update({ id: analysis.id }, { parts, engine });
          await progress(parts.filter((p) => p.done).length / parts.length);
        }
      } finally {
        await file.release();
      }

      const merged = mergeShotParts(
        parts.map((p) => ({ startMs: p.startMs, endMs: p.endMs, shots: p.shots ?? [] })),
      );
      await ds.transaction(async (em) => {
        await em.delete(DetectedShotEntity, { analysisId: analysis.id });
        if (merged.length > 0) {
          await em.insert(
            DetectedShotEntity,
            merged.map((s, seq) => ({
              merchantId: job.merchantId,
              analysisId: analysis.id,
              seq,
              startMs: s.startMs,
              endMs: s.endMs,
              keyframes: s.keyframes,
            })),
          );
        }
        await em.update(AnalysisEntity, { id: analysis.id }, { status: 'ready', engine });
      });
      return {
        analysisId: analysis.id,
        shots: merged.length,
        parts: parts.length,
        detectMs: parts.reduce((n, p) => n + (p.elapsedMs ?? 0), 0),
      };
    },
    next(job) {
      // inside a live-to-clips run, planning follows shot detection
      if (job.payload.nextStep !== 'clips.plan') return [];
      return [
        {
          type: 'clips.plan',
          queue: 'ai',
          payload: { sourceId: job.payload.sourceId, product: job.payload.product ?? {} },
          maxAttempts: 3,
          timeoutMs: 30 * 60_000,
        },
      ];
    },
    async onDead(em, job, error) {
      const sourceId = String(job.payload.sourceId ?? '');
      await em.query(
        `UPDATE analyses SET status = 'failed', error = $3, updated_at = now()
          WHERE source_id = $1 AND merchant_id = $2 AND kind = 'shots' AND status = 'running'`,
        [sourceId, job.merchantId, error.message.slice(0, 2000)],
      );
    },
  };
}
