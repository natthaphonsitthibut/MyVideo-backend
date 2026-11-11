import type { JobSummary } from '@myvideo/contracts';
import type { JobEntity } from '@myvideo/infra';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toJobSummary(j: JobEntity): JobSummary {
  return {
    id: j.id,
    workflowRunId: j.workflowRunId,
    type: j.type,
    queue: j.queue,
    stepIndex: j.stepIndex,
    status: j.status,
    attempts: j.attempts,
    maxAttempts: j.maxAttempts,
    progress: j.progress,
    cancelRequested: j.cancelRequested,
    error: (j.error as JobSummary['error']) ?? null,
    runAfter: j.runAfter.toISOString(),
    createdAt: j.createdAt.toISOString(),
    startedAt: iso(j.startedAt),
    finishedAt: iso(j.finishedAt),
  };
}
