/**
 * Job lifecycle (ARCHITECTURE §5). Postgres holds the status; every change is a conditional UPDATE that
 * checks the `from` status, and only transitions listed here are ever attempted.
 *
 *   pending ──dispatcher──► queued ──claim──► running ──► succeeded
 *      ▲                      │  ▲               ├──► failed (retryable) ──backoff──► pending
 *      │                      │  └─stale lease──┤
 *      │                      └─lost enqueue──► pending
 *      │                                         ├──► dead (fatal / attempts exhausted) ──manual retry──► pending
 *      └──────────── manual retry ◄── cancelled ◄┘ (also from pending / queued / failed)
 */
export const JOB_STATUSES = [
  'pending',
  'queued',
  'running',
  'succeeded',
  'failed',
  'dead',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

const TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  pending: ['queued', 'cancelled'],
  // queued → pending: the queue lost the message (Redis flushed) and the dispatcher re-sends it.
  queued: ['running', 'cancelled', 'pending'],
  // running → queued: the worker died; its lease (heartbeat) expired and the job is handed out again.
  running: ['succeeded', 'failed', 'dead', 'cancelled', 'queued'],
  failed: ['pending', 'cancelled'],
  succeeded: [],
  dead: ['pending'],
  cancelled: ['pending'],
};

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['succeeded', 'dead', 'cancelled'];

export function canJobTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertJobTransition(from: JobStatus, to: JobStatus): void {
  if (!canJobTransition(from, to)) throw new Error(`invalid job transition ${from} → ${to}`);
}

export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status);
}

/** Statuses from which a job may move to `to` — used to build `WHERE status IN (...)` guards. */
export function jobStatusesAllowingTo(to: JobStatus): JobStatus[] {
  return JOB_STATUSES.filter((from) => canJobTransition(from, to));
}
