import { describe, expect, it } from 'vitest';
import {
  computeLiveToClipsReport,
  type ReportInput,
  renderLiveToClipsReport,
} from './live-to-clips-report.js';

// Hand-built arithmetic fixtures, never recording quality or performance evidence.
const fixture = (): ReportInput => ({
  durationMs: 1_800_000,
  attempts: [
    {
      jobName: 'clips.build',
      jobId: 'job-fixture',
      attemptNo: 1,
      status: 'failed',
      startedAt: new Date(0),
      finishedAt: new Date(2000),
      error: { message: 'fixture failure | retry' },
    },
    {
      jobName: 'clips.build',
      jobId: 'job-fixture',
      attemptNo: 2,
      status: 'succeeded',
      startedAt: new Date(3000),
      finishedAt: new Date(8000),
      error: null,
    },
    {
      jobName: 'shots.detect',
      jobId: 'shot-fixture',
      attemptNo: 1,
      status: 'timed_out',
      startedAt: new Date(0),
      finishedAt: new Date(1000),
      error: { message: 'fixture timeout' },
    },
  ],
  calls: [
    {
      mode: 'local-agent',
      status: 'invalid',
      inputTokens: 100,
      cacheReadTokens: 1000,
      cacheWriteTokens: 400,
      outputTokens: 20,
      costUsdEstimate: 0.01,
      error: 'fixture invalid',
    },
    {
      mode: 'local-agent',
      status: 'ok',
      inputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 100,
      outputTokens: 30,
      costUsdEstimate: 0.02,
      error: null,
    },
  ],
  clips: [
    { rank: 2, status: 'ready', startMs: 20000, endMs: 40000, mode: 'rules', error: null },
    { rank: 1, status: 'ready', startMs: 0, endMs: 10000, mode: 'rules', error: null },
    { rank: 3, status: 'failed', startMs: 0, endMs: 10000, mode: 'rules', error: 'fixture build failure' },
    { rank: 4, status: 'discarded', startMs: 0, endMs: 10000, mode: 'rules', error: null },
  ],
  labels: { labelled_by: 'agent', highlights: [{ startS: 0, endS: 10, grade: 2 }] },
});

describe('live-to-clips report with hand-built row fixtures', () => {
  it('aggregates retries and overlapping stage times without treating sum as elapsed time', () => {
    const r = computeLiveToClipsReport(fixture());
    expect(r.stages).toEqual([
      { jobName: 'clips.build', attempts: 2, failures: 1, incomplete: 0, sumMs: 7000, maxMs: 5000 },
      { jobName: 'shots.detect', attempts: 1, failures: 1, incomplete: 0, sumMs: 1000, maxMs: 1000 },
    ]);
    expect(r.totals).toEqual({
      attempts: 3,
      failures: 2,
      incomplete: 0,
      sumMs: 8000,
      maxMs: 5000,
      elapsedMs: 8000,
    });
    expect(r.failures.map((f) => f.error)).toContain('fixture failure | retry');
  });

  it('counts repair calls and normalizes tokens and list-price estimates by video hours', () => {
    const r = computeLiveToClipsReport(fixture());
    expect(r.llm).toMatchObject({
      calls: 2,
      inputTokens: 300,
      cacheReadTokens: 1000,
      cacheWriteTokens: 500,
      outputTokens: 50,
      costUsdEstimate: 0.03,
      missingCostCalls: 0,
    });
    expect(r.llm.perHour).toEqual({
      calls: 4,
      inputTokens: 600,
      cacheReadTokens: 2000,
      cacheWriteTokens: 1000,
      outputTokens: 100,
      costUsdEstimate: 0.06,
    });
  });

  it('evaluates only final ready clips in rank order and retains fixed k denominator', () => {
    const input = fixture();
    const r = computeLiveToClipsReport(input);
    expect(r.clips).toEqual({
      count: 4,
      finalCount: 2,
      minMs: 10000,
      maxMs: 20000,
      meanMs: 15000,
      totalMs: 30000,
    });
    expect(r.precision).toEqual([
      { mode: 'rules', grade: 1, k: 5, hits: 1, precision: 0.2 },
      { mode: 'rules', grade: 2, k: 5, hits: 1, precision: 0.2 },
    ]);
    expect(input.clips[0]?.rank).toBe(2);
  });

  it('does not invent costs or times for missing records', () => {
    const input = fixture();
    if (!input.calls[0] || !input.attempts[1]) throw new Error('Incomplete test fixture');
    input.calls[0].costUsdEstimate = null;
    input.attempts[1].finishedAt = null;
    input.attempts[1].status = 'running';
    const r = computeLiveToClipsReport(input);
    expect(r.llm.costUsdEstimate).toBeNull();
    expect(r.llm.perHour.costUsdEstimate).toBeNull();
    expect(r.llm.missingCostCalls).toBe(1);
    expect(r.totals).toMatchObject({ incomplete: 1, sumMs: 3000, elapsedMs: null });
  });

  it('handles empty rules runs and missing labels without NaN or fabricated precision', () => {
    const r = computeLiveToClipsReport({ durationMs: 3600000, attempts: [], calls: [], clips: [] });
    expect(r.llm.perHour).toEqual({
      calls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      costUsdEstimate: 0,
    });
    expect(r.clips.meanMs).toBeNull();
    expect(r.totals.elapsedMs).toBeNull();
    expect(r.precision).toBeNull();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid source duration fixture %s',
    (durationMs) => {
      expect(() => computeLiveToClipsReport({ ...fixture(), durationMs })).toThrow('duration');
    },
  );

  it('renders provenance, draft labels, estimates, failures and unverified mode text explicitly', () => {
    const input = fixture();
    const md = renderLiveToClipsReport(computeLiveToClipsReport(input), {
      runId: 'run-fixture',
      sourceId: 'source-fixture',
      status: 'succeeded',
      modeLabel: 'trial | run',
      labels: input.labels,
    });
    expect(md).toContain('Verified (from DB)');
    expect(md).toContain('estimate (list price)');
    expect(md).toContain('agent-drafted');
    expect(md).toContain('not human-confirmed ground truth');
    expect(md).toContain('Assumption: mode label');
    expect(md).toContain('fixture failure \\| retry');
    expect(md).toContain('Verified (DB clips + supplied labels)');
  });
});
