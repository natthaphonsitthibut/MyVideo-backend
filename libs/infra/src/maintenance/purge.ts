import { type StoragePort, storageKeys } from '@myvideo/domain';
import type { EntityManager } from 'typeorm';
import { FatalJobError, type JobHandler } from '../jobs/handlers.js';
import { createRunInTransaction, enqueueInTransaction } from '../jobs/job-store.js';
import { refreshRunStatus } from '../jobs/runner.js';

/**
 * Deleting what a merchant asked to delete (E12-F02). Database rows go in the caller's transaction; files go
 * afterwards in a retry-safe `storage.purge` job, so a crash between the two leaves only files to remove again.
 */

/**
 * Stops work about the given subjects (sources / projects): waiting jobs → cancelled, running jobs get
 * `cancel_requested` (their worker aborts them on the next heartbeat). Matches runs by subject and jobs by the
 * `sourceId` / `projectId` in their payload. Returns how many jobs were touched.
 */
export async function cancelSubjectWork(
  em: EntityManager,
  merchantId: string,
  ids: { sourceIds?: string[]; projectIds?: string[] },
): Promise<number> {
  const all = [...(ids.sourceIds ?? []), ...(ids.projectIds ?? [])];
  if (all.length === 0) return 0;
  const match = `merchant_id = $1 AND (
      workflow_run_id IN (SELECT id FROM workflow_runs WHERE merchant_id = $1 AND subject_id = ANY($2::uuid[])
                            AND kind <> 'purge')
      OR payload->>'sourceId' = ANY($3::text[])
      OR payload->>'projectId' = ANY($4::text[]))`;
  const params = [merchantId, all, ids.sourceIds ?? [], ids.projectIds ?? []];
  const waiting: { workflow_run_id: string }[] = await em.query(
    `UPDATE jobs SET status = 'cancelled', cancel_requested = true, finished_at = now(), queued_at = NULL,
            updated_at = now()
      WHERE ${match} AND status IN ('pending', 'queued', 'failed')
      RETURNING workflow_run_id`,
    params,
  );
  const running: { workflow_run_id: string }[] = await em.query(
    `UPDATE jobs SET cancel_requested = true, updated_at = now()
      WHERE ${match} AND status = 'running'
      RETURNING workflow_run_id`,
    params,
  );
  for (const runId of new Set([...waiting, ...running].map((r) => r.workflow_run_id))) {
    await refreshRunStatus(em, runId);
  }
  return waiting.length + running.length;
}

/** Queues the removal of every file under these merchant prefixes (one run per deleted subject). */
export async function enqueuePurge(
  em: EntityManager,
  merchantId: string,
  subject: { type: 'source' | 'project'; id: string },
  prefixes: string[],
): Promise<void> {
  const run = await createRunInTransaction(em, {
    merchantId,
    kind: 'purge',
    subjectType: subject.type,
    subjectId: subject.id,
    input: { prefixes },
  });
  await enqueueInTransaction(em, {
    merchantId,
    workflowRunId: run.id,
    type: 'storage.purge',
    queue: 'media',
    idempotencyKey: `purge:${subject.type}:${subject.id}:${run.id}`,
    payload: { prefixes },
    maxAttempts: 5,
    timeoutMs: 600_000,
  });
}

/** Storage prefix of everything stored for one source (original + derived files). */
export const sourcePrefix = (merchantId: string, sourceId: string) =>
  `${storageKeys.merchantPrefix(merchantId)}sources/${sourceId}/`;

/** Storage prefix of one render's files. */
export const renderPrefix = (merchantId: string, renderId: string) =>
  `${storageKeys.merchantPrefix(merchantId)}renders/${renderId}/`;

const PREFIX_RE = /^m\/[0-9a-f-]{36}\/(sources|renders)\/[0-9a-f-]{36}\/$/;

/**
 * `storage.purge`: deletes every key under each prefix. Idempotent (a missing key is fine) and safe: a prefix
 * must be one of the two shapes above AND belong to the job's merchant, otherwise the job is dead.
 */
export function purgeHandler(storage: StoragePort): JobHandler {
  return {
    type: 'storage.purge',
    queue: 'media',
    async run({ job, signal, progress }) {
      const prefixes = job.payload.prefixes;
      if (!Array.isArray(prefixes) || prefixes.length === 0) throw new FatalJobError('purge: no prefixes');
      const own = storageKeys.merchantPrefix(job.merchantId);
      for (const p of prefixes) {
        if (typeof p !== 'string' || !PREFIX_RE.test(p) || !p.startsWith(own))
          throw new FatalJobError(`purge: refused prefix ${JSON.stringify(p)}`);
      }
      let deleted = 0;
      for (const [i, prefix] of (prefixes as string[]).entries()) {
        for (const key of await storage.list(prefix)) {
          signal.throwIfAborted();
          await storage.delete(key);
          deleted++;
        }
        await progress((i + 1) / prefixes.length);
      }
      return { deleted };
    },
  };
}
