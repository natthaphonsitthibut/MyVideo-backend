import type { JobStatus } from './job-state.js';
import type { RunStatus } from './workflow-state.js';

/** Exponential backoff before retry number `attempt` (1-based): base · 2^(attempt-1), capped. */
export function backoffMs(attempt: number, opts: { baseMs?: number; capMs?: number } = {}): number {
  const base = opts.baseMs ?? 2000;
  const cap = opts.capMs ?? 300_000;
  return Math.min(cap, base * 2 ** (Math.max(1, attempt) - 1));
}

/** A run's status follows its steps (ARCHITECTURE §5.9). */
export function deriveRunStatus(steps: readonly JobStatus[]): RunStatus {
  if (steps.length === 0 || steps.every((s) => s === 'pending')) return 'pending';
  if (steps.includes('dead')) return 'failed';
  if (steps.some((s) => s === 'pending' || s === 'queued' || s === 'running' || s === 'failed'))
    return 'running';
  if (steps.includes('cancelled')) return 'cancelled';
  return 'succeeded';
}
