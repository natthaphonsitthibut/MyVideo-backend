import {
  type FolderFacts,
  type FolderPlan,
  type FolderSourceFacts,
  folderPlan,
  type RunState,
  resolveOutputRatio,
} from '@myvideo/domain';
import type { DataSource, EntityManager } from 'typeorm';
import { requestTranscription, TranscriptionUnavailableError } from '../ai/transcribe-handlers.js';
import {
  BuildClipsUnavailableError,
  LiveToClipsUnavailableError,
  requestBuildClips,
  requestLiveToClips,
} from '../highlights/live-to-clips.js';
import { FatalJobError, type JobHandler } from '../jobs/handlers.js';
import { assertRunCapacity, createRunInTransaction, enqueueInTransaction } from '../jobs/job-store.js';

/**
 * Project folder edit (E12-F05): ONE run per "start" press. It owns no media work itself — its `folder.advance`
 * step looks at the real state of every footage item and starts the next existing workflow that is due
 * (transcribe → live-to-clips analysis → [merchant picks a style] → build clips). It runs again whenever one of
 * those child runs finishes (hook in `refreshRunStatus`) or the merchant picks a style, so nothing polls.
 */
export type FolderEditInput = {
  folderId: string;
  /** Immutable footage selection for this edit; absent only on legacy runs. */
  sourceIds?: string[];
  /** Chosen (or locked) style; null until the merchant picks. */
  styleId: string | null;
  /** Merchant-typed product name from the folder settings (never invented). */
  productName: string | null;
  /** Set when the plan is finished or failed: the run no longer reacts to child runs. */
  closedAt?: string;
};

export class FolderEditUnavailableError extends Error {
  constructor(
    readonly reason: 'not_found' | 'empty' | 'invalid_selection',
    message: string,
  ) {
    super(message);
    this.name = 'FolderEditUnavailableError';
  }
}

type Db = DataSource | EntityManager;

const runState = (s: string | undefined): RunState =>
  s === 'succeeded' ? 'succeeded' : s === 'failed' || s === 'cancelled' ? 'failed' : s ? 'running' : 'none';

/** Real state of every footage item of a folder (current membership), as the plan reads it. */
export async function folderSourceFacts(
  db: Db,
  merchantId: string,
  folderId: string,
  sourceIds?: readonly string[],
): Promise<FolderSourceFacts[]> {
  const rows: {
    id: string;
    status: 'processing' | 'ready' | 'failed';
    probe: { still?: boolean; audio?: unknown } | null;
    transcript_ready: boolean;
    transcribe_status: string | null;
    analysis_id: string | null;
    analysis_status: string | null;
    build_status: string | null;
    clip_count: number;
  }[] = await db.query(
    `SELECT s.id, s.status, s.probe,
        EXISTS (SELECT 1 FROM transcripts t WHERE t.merchant_id = $1 AND t.source_id = s.id AND t.status = 'ready') AS transcript_ready,
        (SELECT r.status FROM workflow_runs r WHERE r.merchant_id = $1 AND r.kind = 'transcribe' AND r.subject_id = s.id AND r.input->>'mode' IS DISTINCT FROM 'selected-clips'
          ORDER BY r.created_at DESC LIMIT 1) AS transcribe_status,
        a.id AS analysis_id, a.status AS analysis_status,
        (SELECT b.status FROM workflow_runs b WHERE b.merchant_id = $1 AND b.kind = 'build_clips' AND b.input->>'planRunId' = a.id::text
          ORDER BY b.created_at DESC LIMIT 1) AS build_status,
        (SELECT count(*)::int FROM clip_suggestions c WHERE c.merchant_id = $1 AND c.workflow_run_id = a.id
          AND c.status <> 'discarded') AS clip_count
      FROM project_folder_sources fs
      JOIN video_sources s ON s.id = fs.source_id AND s.merchant_id = $1
      LEFT JOIN LATERAL (SELECT r.id, r.status FROM workflow_runs r WHERE r.merchant_id = $1 AND r.kind = 'live_to_clips'
          AND r.subject_type = 'source' AND r.subject_id = s.id ORDER BY r.created_at DESC LIMIT 1) a ON true
      WHERE fs.folder_id = $2 AND fs.merchant_id = $1 AND ($3::uuid[] IS NULL OR s.id = ANY($3::uuid[]))
      ORDER BY fs.created_at, fs.id`,
    [merchantId, folderId, sourceIds ?? null],
  );
  return rows.map((r) => ({
    id: r.id,
    ingest: r.status,
    kind: r.probe?.still ? 'photo' : 'video',
    hasAudio: !!r.probe?.audio,
    transcript: r.transcript_ready
      ? 'ready'
      : runState(r.transcribe_status ?? undefined) === 'failed'
        ? 'failed'
        : runState(r.transcribe_status ?? undefined) === 'running'
          ? 'running'
          : 'none',
    analysis: runState(r.analysis_status ?? undefined),
    // analysed and nothing worth cutting: there is nothing to edit for this video
    build:
      r.analysis_status === 'succeeded' && r.clip_count === 0 && !r.build_status
        ? 'succeeded'
        : runState(r.build_status ?? undefined),
  }));
}

/** Newest folder edit of a folder, or null if never started. */
export async function latestFolderEdit(
  db: Db,
  merchantId: string,
  folderId: string,
): Promise<{ id: string; input: FolderEditInput } | null> {
  const rows: { id: string; input: FolderEditInput }[] = await db.query(
    `SELECT id, input FROM workflow_runs WHERE merchant_id = $1 AND kind = 'folder_edit' AND input->>'folderId' = $2
      ORDER BY created_at DESC LIMIT 1`,
    [merchantId, folderId],
  );
  return rows[0] ?? null;
}

export async function folderPlanOf(
  db: Db,
  merchantId: string,
  folderId: string,
): Promise<{ runId: string | null; styleId: string | null; plan: FolderPlan; facts: FolderFacts }> {
  const edit = await latestFolderEdit(db, merchantId, folderId);
  const facts: FolderFacts = {
    started: !!edit,
    styleId: edit?.input.styleId ?? null,
    sources: await folderSourceFacts(db, merchantId, folderId, edit?.input.sourceIds),
  };
  return { runId: edit?.id ?? null, styleId: facts.styleId, plan: folderPlan(facts), facts };
}

const advanceStep = (merchantId: string, runId: string, key: string) => ({
  merchantId,
  workflowRunId: runId,
  type: 'folder.advance',
  queue: 'ai' as const,
  idempotencyKey: `${runId}:folder.advance:${key}`,
  payload: {},
  maxAttempts: 3,
  timeoutMs: 2 * 60_000,
});

/** "Start" on a folder: a new folder edit (an unfinished one is reused). */
export async function requestFolderEdit(
  ds: DataSource,
  input: {
    merchantId: string;
    folderId: string;
    sourceIds?: string[];
    styleId?: string | null;
    maxUnfinishedRuns?: number;
  },
): Promise<{ runId: string; created: boolean }> {
  return ds.transaction(async (em) => {
    const folders: { settings: { productName?: string | null } }[] = await em.query(
      'SELECT settings FROM project_folders WHERE id = $1 AND merchant_id = $2 FOR UPDATE',
      [input.folderId, input.merchantId],
    );
    const folder = folders[0];
    if (!folder) throw new FolderEditUnavailableError('not_found', 'folder not found');
    const members: { source_id: string }[] = await em.query(
      'SELECT source_id FROM project_folder_sources WHERE folder_id = $1 AND merchant_id = $2 ORDER BY created_at, id FOR KEY SHARE',
      [input.folderId, input.merchantId],
    );
    const memberIds = new Set(members.map((s) => s.source_id));
    const sourceIds = input.sourceIds === undefined ? [...memberIds] : [...new Set(input.sourceIds)];
    if (input.sourceIds !== undefined && (!sourceIds.length || sourceIds.some((id) => !memberIds.has(id))))
      throw new FolderEditUnavailableError('invalid_selection', 'select footage belonging to this folder');
    if (!sourceIds.length) throw new FolderEditUnavailableError('empty', 'folder has no footage');
    const open = await latestFolderEdit(em, input.merchantId, input.folderId);
    if (open && !open.input.closedAt) return { runId: open.id, created: false };
    if (input.maxUnfinishedRuns) await assertRunCapacity(em, input.merchantId, input.maxUnfinishedRuns);
    const runInput: FolderEditInput = {
      folderId: input.folderId,
      sourceIds,
      styleId: input.styleId ?? null,
      productName: folder.settings?.productName ?? null,
    };
    const run = await createRunInTransaction(em, {
      merchantId: input.merchantId,
      kind: 'folder_edit',
      subjectType: 'folder',
      subjectId: input.folderId,
      input: runInput,
    });
    await enqueueInTransaction(em, advanceStep(input.merchantId, run.id, 'start'));
    return { runId: run.id, created: true };
  });
}

/** The merchant picked a style for the open folder edit: record it and advance (builds start). */
export async function chooseFolderStyle(
  ds: DataSource,
  input: { merchantId: string; folderId: string; styleId: string },
): Promise<{ runId: string } | null> {
  return ds.transaction(async (em) => {
    const open = await latestFolderEdit(em, input.merchantId, input.folderId);
    if (!open || open.input.closedAt) return null;
    await em.query(
      `UPDATE workflow_runs SET input = jsonb_set(input, '{styleId}', to_jsonb($3::text)), updated_at = now()
        WHERE id = $1 AND merchant_id = $2`,
      [open.id, input.merchantId, input.styleId],
    );
    await enqueueInTransaction(em, advanceStep(input.merchantId, open.id, `style:${input.styleId}`));
    return { runId: open.id };
  });
}

/**
 * Called inside the transaction that moves a child run (any kind but folder_edit) to a terminal state: wake every
 * open folder edit whose folder contains that run's source.
 */
export async function wakeFolderEdits(em: EntityManager, childRunId: string): Promise<void> {
  const rows: { id: string; merchant_id: string; status: string }[] = await em.query(
    `SELECT fe.id, fe.merchant_id, c.status
       FROM workflow_runs c
       JOIN project_folder_sources fs ON fs.source_id = c.subject_id AND fs.merchant_id = c.merchant_id
       JOIN workflow_runs fe ON fe.kind = 'folder_edit' AND fe.merchant_id = c.merchant_id
         AND fe.input->>'folderId' = fs.folder_id::text AND fe.input->>'closedAt' IS NULL
      WHERE c.id = $1 AND c.kind <> 'folder_edit' AND c.subject_type = 'source'
        AND (NOT (fe.input ? 'sourceIds') OR fe.input->'sourceIds' ? c.subject_id::text)`,
    [childRunId],
  );
  for (const r of rows)
    await enqueueInTransaction(em, advanceStep(r.merchant_id, r.id, `${childRunId}:${r.status}`));
}

/** `folder.advance`: start whatever is due now; close the edit when the plan is finished or failed. */
export function folderAdvanceHandler({ ds }: { ds: DataSource }): JobHandler {
  return {
    type: 'folder.advance',
    queue: 'ai',
    async run({ job }) {
      const runs: { input: FolderEditInput }[] = await ds.query(
        `SELECT input FROM workflow_runs WHERE id = $1 AND merchant_id = $2`,
        [job.workflowRunId, job.merchantId],
      );
      const input = runs[0]?.input;
      if (!input) throw new FatalJobError('folder edit run not found');
      if (input.closedAt) return { closed: true };
      const merchantId = job.merchantId;
      const started: string[] = [];
      const sources = await folderSourceFacts(ds, merchantId, input.folderId, input.sourceIds);
      // the frame the clips are edited for: the folder's setting now ("auto" = most of the footage's shape)
      const frame: { settings: { ratio?: string } | null; sizes: { width: number; height: number }[] }[] =
        await ds.query(
          `SELECT f.settings,
             ARRAY(SELECT json_build_object('width', (s.probe->'video'->>'width')::int, 'height', (s.probe->'video'->>'height')::int)
               FROM project_folder_sources fs JOIN video_sources s ON s.id = fs.source_id AND s.merchant_id = fs.merchant_id
              WHERE fs.folder_id = f.id AND fs.merchant_id = $1 AND s.probe IS NOT NULL
                AND ($3::uuid[] IS NULL OR s.id = ANY($3::uuid[]))) AS sizes
           FROM project_folders f WHERE f.id = $2 AND f.merchant_id = $1`,
          [merchantId, input.folderId, input.sourceIds ?? null],
        );
      const ratio = resolveOutputRatio(frame[0]?.settings?.ratio, frame[0]?.sizes ?? []);
      for (const s of sources) {
        if (s.ingest !== 'ready' || s.kind !== 'video' || !s.hasAudio) continue;
        try {
          if (s.transcript === 'none') {
            await requestTranscription(ds, { merchantId, sourceId: s.id });
            started.push(`transcribe:${s.id}`);
          } else if (s.transcript === 'ready' && s.analysis === 'none') {
            await requestLiveToClips(ds, {
              merchantId,
              sourceId: s.id,
              product: input.productName ? { name: input.productName } : {},
            });
            started.push(`analyse:${s.id}`);
          } else if (input.styleId && s.analysis === 'succeeded' && s.build === 'none') {
            await requestBuildClips(ds, { merchantId, sourceId: s.id, styleId: input.styleId, ratio });
            started.push(`build:${s.id}`);
          }
        } catch (err) {
          // a source that cannot go further (no audio, nothing to edit) shows in the plan; others continue
          if (
            !(err instanceof TranscriptionUnavailableError) &&
            !(err instanceof LiveToClipsUnavailableError) &&
            !(err instanceof BuildClipsUnavailableError)
          )
            throw err;
          started.push(`unavailable:${s.id}:${err.reason}`);
        }
      }
      const { plan } = await folderPlanOf(ds, merchantId, input.folderId);
      if (plan.finished || plan.failed)
        await ds.query(
          `UPDATE workflow_runs SET input = input || jsonb_build_object('closedAt', now()::text), updated_at = now()
            WHERE id = $1 AND merchant_id = $2`,
          [job.workflowRunId, merchantId],
        );
      return {
        started,
        ratio,
        done: plan.done,
        total: plan.total,
        finished: plan.finished,
        failed: plan.failed,
      };
    },
  };
}
