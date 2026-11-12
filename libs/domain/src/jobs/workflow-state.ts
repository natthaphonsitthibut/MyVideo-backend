/** Workflow run lifecycle: a run is a list of steps (jobs); its status follows its steps. */
export const RUN_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

const TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  pending: ['running', 'cancelled'],
  running: ['succeeded', 'failed', 'cancelled'],
  // failed/cancelled → running: a dead or cancelled step was retried manually.
  failed: ['running', 'cancelled'],
  succeeded: [],
  cancelled: ['running'],
};

export function canRunTransition(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!canRunTransition(from, to)) throw new Error(`invalid workflow run transition ${from} → ${to}`);
}

export const WORKFLOW_KINDS = [
  'ingest',
  'transcribe',
  'live_to_clips',
  'restyle_clip',
  'build_clips',
  'review_to_video',
  'render',
  'purge',
  'system_test',
] as const;
export type WorkflowKind = (typeof WORKFLOW_KINDS)[number];

export const QUEUES = ['media', 'ai', 'render'] as const;
export type QueueName = (typeof QUEUES)[number];
