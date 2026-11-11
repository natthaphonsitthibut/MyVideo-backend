import { describe, expect, it } from 'vitest';
import { backoffMs, deriveRunStatus } from './retry.js';

describe('backoffMs', () => {
  it('doubles per attempt from the base and caps', () => {
    expect([1, 2, 3, 4].map((a) => backoffMs(a, { baseMs: 1000, capMs: 5000 }))).toEqual([
      1000, 2000, 4000, 5000,
    ]);
  });
  it('defaults to 2 s base, 5 min cap', () => {
    expect(backoffMs(1)).toBe(2000);
    expect(backoffMs(30)).toBe(300_000);
  });
  it('treats attempt < 1 as the first', () => {
    expect(backoffMs(0, { baseMs: 10 })).toBe(10);
  });
});

describe('deriveRunStatus', () => {
  it('is pending when nothing has started', () => {
    expect(deriveRunStatus(['pending', 'pending'])).toBe('pending');
  });
  it('is running while any step is in flight or waiting to retry', () => {
    expect(deriveRunStatus(['succeeded', 'queued'])).toBe('running');
    expect(deriveRunStatus(['succeeded', 'running'])).toBe('running');
    expect(deriveRunStatus(['failed'])).toBe('running');
    expect(deriveRunStatus(['succeeded', 'pending'])).toBe('running');
  });
  it('fails as soon as one step is dead', () => {
    expect(deriveRunStatus(['succeeded', 'dead', 'pending'])).toBe('failed');
  });
  it('is cancelled when a step was cancelled and none is dead', () => {
    expect(deriveRunStatus(['succeeded', 'cancelled'])).toBe('cancelled');
  });
  it('succeeds only when every step succeeded', () => {
    expect(deriveRunStatus(['succeeded', 'succeeded'])).toBe('succeeded');
    expect(deriveRunStatus([])).toBe('pending');
  });
});
