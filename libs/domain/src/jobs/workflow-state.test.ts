import { describe, expect, it } from 'vitest';
import { canRunTransition, RUN_STATUSES, type RunStatus } from './workflow-state.js';

const ALLOWED: Record<RunStatus, RunStatus[]> = {
  pending: ['running', 'cancelled'],
  running: ['succeeded', 'failed', 'cancelled'],
  failed: ['running', 'cancelled'],
  succeeded: [],
  cancelled: ['running'],
};

describe('workflow run state machine', () => {
  for (const from of RUN_STATUSES) {
    for (const to of RUN_STATUSES) {
      const ok = ALLOWED[from].includes(to);
      it(`${from} → ${to} is ${ok ? 'allowed' : 'forbidden'}`, () => {
        expect(canRunTransition(from, to)).toBe(ok);
      });
    }
  }
});
