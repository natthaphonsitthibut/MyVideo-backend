import {
  BRAND_DEFAULTS,
  type BrandKit,
  SHOT_ROLES,
  type ShotRole,
  type TemplateVersion,
  templateVersion,
} from '@myvideo/contracts';
import type { StoragePort } from '@myvideo/domain';
import { SHOTS_RECIPE } from '@myvideo/domain';
import type { DataSource, EntityManager } from 'typeorm';
import type { AiServiceClient } from '../ai/ai-service.client.js';
import { AnalysisEntity, DetectedShotEntity } from '../db/entities/analysis.entity.js';
import { ProjectEntity, ProjectVersionEntity } from '../db/entities/project.entity.js';
import { TranscriptEntity } from '../db/entities/transcript.entity.js';
import { seededIds } from '../highlights/clip-project.js';
import { loadCorrectedTranscript } from '../highlights/live-to-clips.js';
import { FatalJobError, type JobHandler, type NextStep } from '../jobs/handlers.js';
import { assertRunCapacity, createRunInTransaction, enqueueInTransaction } from '../jobs/job-store.js';
import type { ProbeInfo } from '../media/probe.js';
import type { StageTextLayout } from '../render/text-layout.js';
import { classifyShot, LOW_CONFIDENCE } from './shot-roles.js';
import { type MissingShot, planTemplate, type TemplatePiece, type TemplateShot } from './template-engine.js';
import { buildTemplateProject, templateCaptionWords } from './template-project.js';

/**
 * Review-to-Video (E10-F06): several phone clips of one product → shots → roles → template → an editable project.
 * Run input: sources, template (+ version), product (the merchant's name + points), role overrides the merchant
 * picked. Steps: `shots.detect` per source (fan-out) → `review.build` once all are done (fan-in in `next`).
 */
export const REVIEW_MAX_SOURCES = 8;
export type ReviewProduct = { name: string; points: string[] };
export type ReviewInput = {
  sourceIds: string[];
  templateId: string;
  templateVersion: number;
  product: ReviewProduct;
  /** `${sourceId}:${shotSeq}` → role chosen by the merchant. */
  roles?: Record<string, ShotRole>;
  /** Swap template on an existing project: build a new version of it instead of a new project. */
  projectId?: string;
};
export type ReviewShot = {
  sourceId: string;
  seq: number;
  startMs: number;
  endMs: number;
  role: ShotRole;
  confidence: number;
  reason: string;
  chosenByMerchant: boolean;
  needsChoice: boolean;
};
export type ReviewResult =
  | { status: 'ready'; projectId: string; shots: ReviewShot[] }
  | { status: 'missing'; missing: MissingShot[]; shots: ReviewShot[] };

export class ReviewVideoUnavailableError extends Error {
  constructor(
    readonly reason: 'not_found' | 'not_ready' | 'unknown_template' | 'too_many',
    message: string,
  ) {
    super(message);
    this.name = 'ReviewVideoUnavailableError';
  }
}

export async function requestReviewVideo(
  ds: DataSource,
  input: ReviewInput & { merchantId: string; maxUnfinishedRuns?: number },
): Promise<{ runId: string }> {
  const t = templateVersion(input.templateId, input.templateVersion || undefined);
  if (!t) throw new ReviewVideoUnavailableError('unknown_template', 'unknown template');
  const sourceIds = [...new Set(input.sourceIds)];
  if (sourceIds.length === 0 || sourceIds.length > REVIEW_MAX_SOURCES)
    throw new ReviewVideoUnavailableError('too_many', `choose 1–${REVIEW_MAX_SOURCES} videos`);
  return ds.transaction(async (em) => {
    const rows: { id: string; status: string }[] = await em.query(
      `SELECT id, status FROM video_sources WHERE merchant_id = $1 AND id = ANY($2::uuid[]) FOR UPDATE`,
      [input.merchantId, sourceIds],
    );
    if (rows.length !== sourceIds.length)
      throw new ReviewVideoUnavailableError('not_found', 'video not found');
    if (rows.some((r) => r.status !== 'ready'))
      throw new ReviewVideoUnavailableError('not_ready', 'a video is still processing or failed');
    if (input.projectId) {
      const owns = await em
        .getRepository(ProjectEntity)
        .existsBy({ id: input.projectId, merchantId: input.merchantId });
      if (!owns) throw new ReviewVideoUnavailableError('not_found', 'project not found');
    }
    if (input.maxUnfinishedRuns) await assertRunCapacity(em, input.merchantId, input.maxUnfinishedRuns);
    const runInput: ReviewInput = {
      sourceIds,
      templateId: t.id,
      templateVersion: t.version,
      product: {
        name: input.product.name.normalize('NFC').trim().slice(0, 80),
        points: input.product.points
          .map((p) => p.normalize('NFC').trim().slice(0, 60))
          .filter(Boolean)
          .slice(0, 4),
      },
      ...(input.roles ? { roles: input.roles } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
    };
    const run = await createRunInTransaction(em, {
      merchantId: input.merchantId,
      kind: 'review_to_video',
      subjectType: input.projectId ? 'project' : 'source',
      subjectId: input.projectId ?? (sourceIds[0] as string),
      input: runInput,
    });
    for (const sourceId of sourceIds) {
      await enqueueInTransaction(em, {
        merchantId: input.merchantId,
        workflowRunId: run.id,
        type: 'shots.detect',
        queue: 'ai',
        idempotencyKey: `${run.id}:shots.detect:${sourceId}`,
        payload: { sourceId, nextStep: 'review.build' },
        timeoutMs: 60 * 60_000,
      });
    }
    return { runId: run.id };
  });
}

/** Fan-in, called by `shots.detect.next` inside the transaction that marks it succeeded. */
export async function reviewBuildStep(
  em: EntityManager,
  workflowRunId: string,
  jobId: string,
): Promise<NextStep[]> {
  const open: unknown[] = await em.query(
    `SELECT 1 FROM jobs WHERE workflow_run_id = $1 AND type = 'shots.detect' AND id <> $2 AND status <> 'succeeded'`,
    [workflowRunId, jobId],
  );
  if (open.length > 0) return [];
  return [{ type: 'review.build', queue: 'ai', payload: {}, maxAttempts: 3, timeoutMs: 15 * 60_000 }];
}

export type ReviewDeps = {
  ds: DataSource;
  storage: StoragePort;
  ai: AiServiceClient;
  openLayout: () => Promise<StageTextLayout>;
};

async function loadShots(deps: ReviewDeps, merchantId: string, sourceId: string, signal: AbortSignal) {
  const analysis = await deps.ds
    .getRepository(AnalysisEntity)
    .findOneBy({ merchantId, sourceId, kind: 'shots', recipeVersion: SHOTS_RECIPE, status: 'ready' });
  if (!analysis) throw new FatalJobError('ยังหาช็อตของวิดีโอไม่เสร็จ');
  const shots = await deps.ds
    .getRepository(DetectedShotEntity)
    .find({ where: { merchantId, analysisId: analysis.id }, order: { seq: 'ASC' } });
  // face presence on each shot's keyframes (local files from storage)
  const files = await Promise.all(
    shots.flatMap((s) => s.keyframes.map((k) => deps.storage.localPath(k.storageKey))),
  );
  try {
    const ratios = new Map<string, number>();
    if (files.length > 0) {
      const r = await deps.ai.faces(
        files.map((f) => f.path),
        { signal },
      );
      for (const [i, img] of r.images.entries()) ratios.set(files[i]?.path ?? '', img.largest_ratio);
    }
    let i = 0;
    return shots.map((s) => ({
      seq: s.seq,
      startMs: s.startMs,
      endMs: s.endMs,
      faces: s.keyframes.map(() => ratios.get(files[i++]?.path ?? '') ?? 0),
    }));
  } finally {
    await Promise.all(files.map((f) => f.release()));
  }
}

export function reviewBuildHandler(deps: ReviewDeps): JobHandler {
  const { ds } = deps;
  return {
    type: 'review.build',
    queue: 'ai',
    async run({ job, signal }) {
      const runs: { input: ReviewInput }[] = await ds.query(
        `SELECT input FROM workflow_runs WHERE id = $1 AND merchant_id = $2`,
        [job.workflowRunId, job.merchantId],
      );
      const input = runs[0]?.input;
      if (!input) throw new FatalJobError('run not found');
      const t: TemplateVersion | undefined = templateVersion(input.templateId, input.templateVersion);
      if (!t) throw new FatalJobError('unknown template');
      const all: TemplateShot[] = [];
      const shown: ReviewShot[] = [];
      const words = new Map<string, { text: string; startMs: number; endMs: number }[]>();
      const sources: { sourceId: string; durationMs: number; hasAudio: boolean; title: string }[] = [];
      for (const sourceId of input.sourceIds) {
        signal.throwIfAborted();
        const src: { probe: ProbeInfo | null; title: string }[] = await ds.query(
          `SELECT probe, title FROM video_sources WHERE id = $1 AND merchant_id = $2`,
          [sourceId, job.merchantId],
        );
        const probe = src[0]?.probe;
        if (!probe) throw new FatalJobError('video has no probe result');
        sources.push({
          sourceId,
          durationMs: probe.durationMs,
          hasAudio: probe.audio !== null,
          title: src[0]?.title ?? '',
        });
        const hasTranscript = await ds
          .getRepository(TranscriptEntity)
          .existsBy({ merchantId: job.merchantId, sourceId, status: 'ready' });
        const spoken = hasTranscript
          ? (await loadCorrectedTranscript(ds, job.merchantId, sourceId)).segments.flatMap((s) =>
              s.words.map((w) => ({ text: w.text, startMs: w.startMs, endMs: w.endMs })),
            )
          : [];
        words.set(sourceId, spoken);
        for (const s of await loadShots(deps, job.merchantId, sourceId, signal)) {
          const inShot = spoken.filter((w) => w.startMs >= s.startMs && w.endMs <= s.endMs);
          const guess = classifyShot({ startMs: s.startMs, endMs: s.endMs, faces: s.faces, words: inShot });
          const chosen = input.roles?.[`${sourceId}:${s.seq}`];
          const role = chosen && (SHOT_ROLES as readonly string[]).includes(chosen) ? chosen : guess.role;
          const confidence = chosen ? 1 : guess.confidence;
          all.push({
            sourceId,
            index: s.seq,
            startMs: s.startMs,
            endMs: s.endMs,
            role,
            confidence,
            words: inShot,
          });
          shown.push({
            sourceId,
            seq: s.seq,
            startMs: s.startMs,
            endMs: s.endMs,
            role,
            confidence,
            reason: chosen ? 'คุณเลือกเอง' : guess.reason,
            chosenByMerchant: Boolean(chosen),
            needsChoice: !chosen && confidence < LOW_CONFIDENCE,
          });
        }
      }
      const plan = planTemplate(t, all, input.product);
      if (!plan.ok) return { status: 'missing', missing: plan.missing, shots: shown } satisfies ReviewResult;

      const kit = await brandKit(ds, job.merchantId);
      const project = await layoutAndBuild(deps, {
        t,
        pieces: plan.pieces,
        words,
        sources,
        cta: kit.defaultCta,
        projectId: input.projectId ?? seededIds(`${job.workflowRunId}:project`)(),
        merchantId: job.merchantId,
        workflowRunId: job.workflowRunId,
        title: input.product.name || sources[0]?.title || t.name,
      });
      await saveProject(ds, project, Boolean(input.projectId));
      return { status: 'ready', projectId: project.id, shots: shown } satisfies ReviewResult;
    },
  };
}

async function brandKit(ds: DataSource, merchantId: string): Promise<Pick<BrandKit, 'defaultCta'>> {
  const rows: { default_cta: string }[] = await ds.query(
    `SELECT default_cta FROM brand_kits WHERE merchant_id = $1`,
    [merchantId],
  );
  return { defaultCta: rows[0]?.default_cta ?? BRAND_DEFAULTS.defaultCta };
}

const TEXT = { fontWeight: 800, fontSizes: [80, 68, 56], maxWidth: 760, maxLines: 2 };
const CTA = { fontWeight: 800, fontSizes: [72, 64, 56], maxWidth: 620, maxLines: 1 };

async function layoutAndBuild(
  deps: ReviewDeps,
  a: {
    t: TemplateVersion;
    pieces: TemplatePiece[];
    words: Map<string, { text: string; startMs: number; endMs: number }[]>;
    sources: { sourceId: string; durationMs: number; hasAudio: boolean }[];
    cta: string;
    projectId: string;
    merchantId: string;
    workflowRunId: string;
    title: string;
  },
) {
  const layout = await deps.openLayout();
  try {
    const capWords = templateCaptionWords(a.pieces, a.words);
    const captionPages = capWords.length
      ? await layout.layoutCaptions(capWords, { styleRef: a.t.captions.styleRef, canvasWidth: 1080 })
      : [];
    const pieceTexts = [];
    for (const p of a.pieces) pieceTexts.push(p.text ? await layout.layoutText(p.text.value, TEXT) : null);
    const cta = await layout.layoutText(a.cta, CTA);
    return buildTemplateProject({
      projectId: a.projectId,
      merchantId: a.merchantId,
      workflowRunId: a.workflowRunId,
      seed: `${a.workflowRunId}:template`,
      title: a.title,
      template: a.t,
      pieces: a.pieces,
      sources: a.sources,
      captionPages,
      pieceTexts,
      cta,
    });
  } finally {
    await layout.close();
  }
}

/** New project (version 1), or — for a template swap — a new version of the existing one (old ones restorable). */
async function saveProject(ds: DataSource, project: ReturnType<typeof buildTemplateProject>, swap: boolean) {
  await ds.transaction(async (em) => {
    const repo = em.getRepository(ProjectEntity);
    const existing = await repo.findOne({
      where: { id: project.id, merchantId: project.merchantId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!existing) {
      await repo.insert({
        id: project.id,
        merchantId: project.merchantId,
        title: (project.meta.title ?? '').slice(0, 200) || 'วิดีโอรีวิว',
        currentVersion: 1,
      });
      await em.getRepository(ProjectVersionEntity).insert({
        merchantId: project.merchantId,
        projectId: project.id,
        version: 1,
        doc: project as never,
        reason: 'create',
        restoredFrom: null,
      });
      return;
    }
    if (!swap) return; // a retried build: the project is already there
    const version = existing.currentVersion + 1;
    await em.getRepository(ProjectVersionEntity).insert({
      merchantId: project.merchantId,
      projectId: project.id,
      version,
      doc: project as never,
      reason: 'template',
      restoredFrom: null,
    });
    await repo.update({ id: project.id, merchantId: project.merchantId }, { currentVersion: version });
  });
}
