import { describe, expect, it } from 'vitest';
import {
  assertJobTransition,
  canJobTransition,
  isTerminalJobStatus,
  JOB_STATUSES,
  type JobStatus,
} from './job-state.js';

// Every allowed transition, written out once so the test is the spec (ARCHITECTURE §5).
const ALLOWED: Record<JobStatus, JobStatus[]> = {
  pending: ['queued', 'cancelled'],
  queued: ['running', 'cancelled', 'pending'],
  running: ['succeeded', 'failed', 'dead', 'cancelled', 'queued'],
  failed: ['pending', 'cancelled'],
  succeeded: [],
  dead: ['pending'],
  cancelled: ['pending'],
};

describe('job state machine', () => {
  it('lists every status exactly once', () => {
    expect([...JOB_STATUSES].sort()).toEqual(Object.keys(ALLOWED).sort());
  });

  for (const from of JOB_STATUSES) {
    for (const to of JOB_STATUSES) {
      const ok = ALLOWED[from].includes(to);
      it(`${from} → ${to} is ${ok ? 'allowed' : 'forbidden'}`, () => {
        expect(canJobTransition(from, to)).toBe(ok);
        if (ok) expect(() => assertJobTransition(from, to)).not.toThrow();
        else expect(() => assertJobTransition(from, to)).toThrow(/invalid job transition/);
      });
    }
  }

  it('knows the terminal statuses', () => {
    expect(JOB_STATUSES.filter(isTerminalJobStatus).sort()).toEqual(['cancelled', 'dead', 'succeeded']);
  });
});
