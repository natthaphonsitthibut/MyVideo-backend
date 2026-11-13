import { type FrozenStyle, STYLE_PACKS } from '@myvideo/contracts';
import type { DataSource } from 'typeorm';
import { ClipSuggestionEntity } from '../db/entities/clip-suggestion.entity.js';
import { ProjectEntity, ProjectVersionEntity } from '../db/entities/project.entity.js';
import { VideoSourceEntity } from '../db/entities/video-source.entity.js';
import { FatalJobError, type JobHandler } from '../jobs/handlers.js';
import { assertRunCapacity, createRunInTransaction, enqueueInTransaction } from '../jobs/job-store.js';
import type { ProbeInfo } from '../media/probe.js';
import { customStyle } from '../reference/reference-store.js';
import type { StageTextLayout } from '../render/text-layout.js';
import { parseClipBuildInput } from './clip-build-input.js';
import { codeCritic, storyNote } from './director.js';
import { layoutClip, sourceInfo } from './live-to-clips.js';

/**
 * Restyle (E07-F12): an AI-made clip is rebuilt with another style pack from the inputs its build stored — the
 * same corrected words, cuts, hook and title — and saved as a NEW project version (older versions stay
 * restorable). No AI call: the handler has no LLM at all (ARCHITECTURE guardrail 4).
 */
export class RestyleUnavailableError extends Error {
  constructor(
    readonly reason: 'not_found' | 'unknown_style' | 'no_build_input',
    message: string,
  ) {
    super(message);
    this.name = 'RestyleUnavailableError';
  }
}

const STYLE_IDS = new Set(STYLE_PACKS.map((p) => p.id));

async function suggestionOf(ds: DataSource, merchantId: string, projectId: string) {
  return ds
    .getRepository(ClipSuggestionEntity)
    .findOne({ where: { merchantId, projectId }, order: { createdAt: 'DESC' } });
}

export async function requestRestyle(
  ds: DataSource,
  input: { merchantId: string; projectId: string; styleId: string; maxUnfinishedRuns?: number },
): Promise<{ runId: string }> {
  const frozenStyle = await customStyle(ds, input.merchantId, input.styleId);
  if (!STYLE_IDS.has(input.styleId) && !frozenStyle)
    throw new RestyleUnavailableError('unknown_style', 'unknown style');
  return ds.transaction(async (em) => {
    const project = await em
      .getRepository(ProjectEntity)
      .findOneBy({ id: input.projectId, merchantId: input.merchantId });
    if (!project) throw new RestyleUnavailableError('not_found', 'project not found');
    const s = await em.getRepository(ClipSuggestionEntity).findOne({
      where: { merchantId: input.merchantId, projectId: input.projectId },
      order: { createdAt: 'DESC' },
    });
    if (!s || !parseClipBuildInput(s.buildInput))
      throw new RestyleUnavailableError('no_build_input', 'clip has no stored build input');
    if (input.maxUnfinishedRuns) await assertRunCapacity(em, input.merchantId, input.maxUnfinishedRuns);
    const run = await createRunInTransaction(em, {
      merchantId: input.merchantId,
      kind: 'restyle_clip',
      subjectType: 'project',
      subjectId: input.projectId,
      input: { styleId: input.styleId },
    });
    await enqueueInTransaction(em, {
      merchantId: input.merchantId,
      workflowRunId: run.id,
      type: 'clips.restyle',
      queue: 'ai',
      idempotencyKey: `${run.id}:clips.restyle`,
      payload: {
        projectId: input.projectId,
        styleId: input.styleId,
        ...(frozenStyle ? { frozenStyle } : {}),
      },
      timeoutMs: 10 * 60_000,
    });
    return { runId: run.id };
  });
}

const styleOf = (doc: unknown) => (doc as { meta?: { styleId?: unknown } } | null)?.meta?.styleId;

export function clipsRestyleHandler({
  ds,
  openLayout,
}: {
  ds: DataSource;
  openLayout: () => Promise<StageTextLayout>;
}): JobHandler {
  return {
    type: 'clips.restyle',
    queue: 'ai',
    async run({ job }) {
      const projectId = String(job.payload.projectId ?? '');
      const styleId = String(job.payload.styleId ?? '');
      const frozenStyle = job.payload.frozenStyle as FrozenStyle | undefined;
      if (!STYLE_IDS.has(styleId) && frozenStyle?.pack.id !== styleId)
        throw new FatalJobError(`unknown style ${styleId}`);
      const s = await suggestionOf(ds, job.merchantId, projectId);
      const input = parseClipBuildInput(s?.buildInput);
      if (!s || !input) throw new FatalJobError('คลิปนี้สร้างก่อนรองรับการเปลี่ยนสไตล์ — สร้างคลิปใหม่อีกครั้ง');
      const current = async () => {
        const p = await ds
          .getRepository(ProjectEntity)
          .findOneByOrFail({ id: projectId, merchantId: job.merchantId });
        return ds
          .getRepository(ProjectVersionEntity)
          .findOneByOrFail({ projectId, version: p.currentVersion });
      };
      // a retry after a committed attempt finds its own version: nothing to do
      if (styleOf((await current()).doc) === styleId) return { projectId, reused: true };

      const source = await ds
        .getRepository(VideoSourceEntity)
        .findOneBy({ id: s.sourceId, merchantId: job.merchantId });
      const probe = source?.probe as ProbeInfo | null | undefined;
      if (!source || !probe) throw new FatalJobError('source of the clip is missing or has no probe result');
      const doc = await layoutClip(openLayout, {
        projectId,
        merchantId: job.merchantId,
        workflowRunId: s.workflowRunId,
        rank: s.rank,
        source: sourceInfo(source.id, probe),
        input: { ...input, ...(frozenStyle ? { frozenStyle } : {}) },
        styleId,
      });
      doc.meta.director = {
        version: 1,
        story: storyNote(
          doc,
          input.words,
          input.hookVariants ?? (input.hook ? [input.hook.text] : []),
          input.directorChoice?.structure ?? 'live-offer',
        ),
        checks: codeCritic(doc, {
          sourceIds: [source.id, ...(input.photos ?? []).map((p) => p.sourceId)],
          words: input.words,
          product: input.productName ? { name: input.productName } : {},
        }),
        judge: {
          status: 'not_run',
          reason: 'Restyle reuses stored decisions; new visual layout needs review',
          rounds: [],
        },
      };

      const version = await ds.transaction(async (em) => {
        const rows: { current_version: number }[] = await em.query(
          `SELECT current_version FROM projects WHERE id = $1 AND merchant_id = $2 FOR UPDATE`,
          [projectId, job.merchantId],
        );
        const base = rows[0]?.current_version;
        if (base === undefined) throw new FatalJobError('project was deleted');
        const cur = await em
          .getRepository(ProjectVersionEntity)
          .findOneByOrFail({ projectId, version: base });
        if (styleOf(cur.doc) === styleId) return null;
        // a new version on top of whatever is current (a concurrent editor save then gets a version conflict
        // and reloads — nothing is overwritten)
        await em.query(
          `UPDATE projects SET current_version = $3, updated_at = now() WHERE id = $1 AND merchant_id = $2`,
          [projectId, job.merchantId, base + 1],
        );
        await em.getRepository(ProjectVersionEntity).insert({
          merchantId: job.merchantId,
          projectId,
          version: base + 1,
          doc: doc as never,
          reason: 'restyle',
          restoredFrom: null,
        });
        return base + 1;
      });
      return version === null ? { projectId, reused: true } : { projectId, version, styleId };
    },
  };
}
