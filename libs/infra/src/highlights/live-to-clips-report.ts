import { type HighlightLabel, precisionAtK } from '@myvideo/domain';
import type { ClipSuggestionEntity } from '../db/entities/clip-suggestion.entity.js';
import type { JobAttemptEntity } from '../db/entities/job-attempt.entity.js';
import type { LlmCallEntity } from '../db/entities/llm-call.entity.js';

export type ReportLabels = { labelled_by: string; sha256?: string; highlights: HighlightLabel[] };
export type ReportInput = {
  durationMs: number;
  attempts: (Pick<
    JobAttemptEntity,
    'jobId' | 'attemptNo' | 'status' | 'startedAt' | 'finishedAt' | 'error'
  > & { jobName: string })[];
  calls: Pick<
    LlmCallEntity,
    | 'mode'
    | 'status'
    | 'inputTokens'
    | 'cacheReadTokens'
    | 'cacheWriteTokens'
    | 'outputTokens'
    | 'costUsdEstimate'
    | 'error'
  >[];
  clips: Pick<ClipSuggestionEntity, 'rank' | 'status' | 'startMs' | 'endMs' | 'mode' | 'error'>[];
  labels?: ReportLabels;
};

/** One run only; callers scope every row to the same run and merchant. No clock, I/O or price lookup. */
export function computeLiveToClipsReport(input: ReportInput) {
  if (!Number.isFinite(input.durationMs) || input.durationMs <= 0) throw new Error('Invalid source duration');
  const hours = input.durationMs / 3_600_000;
  const failures: { location: string; status: string; error: string }[] = [];
  const stages = new Map<
    string,
    {
      jobName: string;
      attempts: number;
      failures: number;
      incomplete: number;
      sumMs: number;
      maxMs: number | null;
    }
  >();
  let first: number | null = null;
  let last: number | null = null;
  for (const a of input.attempts) {
    const s = stages.get(a.jobName) ?? {
      jobName: a.jobName,
      attempts: 0,
      failures: 0,
      incomplete: 0,
      sumMs: 0,
      maxMs: null,
    };
    stages.set(a.jobName, s);
    s.attempts++;
    const start = a.startedAt.getTime();
    const end = a.finishedAt?.getTime();
    if (!Number.isFinite(start) || (end !== undefined && (!Number.isFinite(end) || end < start)))
      throw new Error('Invalid attempt timestamps');
    first = first === null ? start : Math.min(first, start);
    if (end === undefined) s.incomplete++;
    else {
      const ms = end - start;
      s.sumMs += ms;
      s.maxMs = Math.max(s.maxMs ?? 0, ms);
      last = Math.max(last ?? end, end);
    }
    if (a.status === 'failed' || a.status === 'timed_out') s.failures++;
    if (a.status === 'failed' || a.status === 'timed_out' || a.status === 'cancelled') {
      failures.push({
        location: `${a.jobName} / ${a.jobId} / attempt ${a.attemptNo}`,
        status: a.status,
        error: errorText(a.error),
      });
    }
  }
  const stageRows = [...stages.values()].sort((a, b) => a.jobName.localeCompare(b.jobName));
  const totals = stageRows.reduce(
    (t, s) => ({
      attempts: t.attempts + s.attempts,
      failures: t.failures + s.failures,
      incomplete: t.incomplete + s.incomplete,
      sumMs: t.sumMs + s.sumMs,
      maxMs: s.maxMs === null ? t.maxMs : Math.max(t.maxMs ?? 0, s.maxMs),
    }),
    { attempts: 0, failures: 0, incomplete: 0, sumMs: 0, maxMs: null as number | null },
  );
  const inputTokens = input.calls.reduce((n, c) => n + c.inputTokens, 0);
  const cacheReadTokens = input.calls.reduce((n, c) => n + c.cacheReadTokens, 0);
  const cacheWriteTokens = input.calls.reduce((n, c) => n + c.cacheWriteTokens, 0);
  const outputTokens = input.calls.reduce((n, c) => n + c.outputTokens, 0);
  const missingCostCalls = input.calls.filter((c) => c.costUsdEstimate === null).length;
  const costUsdEstimate = missingCostCalls
    ? null
    : input.calls.reduce((n, c) => n + (c.costUsdEstimate ?? 0), 0);
  for (const [i, c] of input.calls.entries()) {
    if (c.status !== 'ok')
      failures.push({
        location: `LLM row ${i + 1} (${c.mode})`,
        status: c.status,
        error: c.error ?? 'No error text recorded',
      });
  }
  for (const c of input.clips) {
    if (c.status === 'failed')
      failures.push({
        location: `clip rank ${c.rank}`,
        status: c.status,
        error: c.error ?? 'No error text recorded',
      });
  }
  const final = input.clips.filter((c) => c.status === 'ready').sort((a, b) => a.rank - b.rank);
  const lengths = final.map((c) => c.endMs - c.startMs);
  const totalMs = lengths.reduce((a, b) => a + b, 0);
  const precision = input.labels
    ? [...new Set(input.clips.map((c) => c.mode))].sort().flatMap((mode) =>
        [1, 2].map((grade) => ({
          mode,
          grade,
          ...precisionAtK(
            final.filter((c) => c.mode === mode),
            input.labels?.highlights ?? [],
            5,
            grade,
          ),
        })),
      )
    : null;
  return {
    durationMs: input.durationMs,
    stages: stageRows,
    totals: {
      ...totals,
      elapsedMs: totals.incomplete || first === null || last === null ? null : last - first,
    },
    llm: {
      calls: input.calls.length,
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
      costUsdEstimate,
      missingCostCalls,
      modes: [...new Set(input.calls.map((c) => c.mode))].sort(),
      perHour: {
        calls: input.calls.length / hours,
        inputTokens: inputTokens / hours,
        cacheReadTokens: cacheReadTokens / hours,
        cacheWriteTokens: cacheWriteTokens / hours,
        outputTokens: outputTokens / hours,
        costUsdEstimate: costUsdEstimate === null ? null : costUsdEstimate / hours,
      },
    },
    clips: {
      count: input.clips.length,
      finalCount: final.length,
      minMs: lengths.length ? Math.min(...lengths) : null,
      maxMs: lengths.length ? Math.max(...lengths) : null,
      meanMs: lengths.length ? totalMs / lengths.length : null,
      totalMs,
    },
    precision,
    failures,
  };
}

function errorText(error: Record<string, unknown> | null): string {
  if (!error) return 'No error text recorded';
  return typeof error.message === 'string' ? error.message : JSON.stringify(error);
}

// Errors are retained for diagnosis, but credentials must not enter a shareable report.
function cell(value: string): string {
  return value
    .replace(/\b(?:postgres(?:ql)?|https?):\/\/\S+/gi, '[URL redacted]')
    .replace(
      /\b(?:Bearer\s+\S+|(?:password|token|api[_-]?key|secret)\s*[=:]\s*\S+)/gi,
      '[credential redacted]',
    )
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]+/g, ' ');
}

export function renderLiveToClipsReport(
  report: ReturnType<typeof computeLiveToClipsReport>,
  meta: {
    runId: string;
    sourceId: string;
    status: string;
    modeLabel?: string;
    labels?: ReportLabels;
    runError?: Record<string, unknown> | null;
  },
): string {
  const v = (n: number | null) =>
    n === null ? 'Unknown (not recorded or incomplete)' : `Verified (from DB): ${n}`;
  const lines = [
    '# Live-to-clips evaluation and cost report',
    '',
    `Verified (from DB): run ${cell(meta.runId)}; source ${cell(meta.sourceId)}; status ${cell(meta.status)}.`,
    `Assumption: mode label (operator supplied, not DB evidence): ${cell(meta.modeLabel ?? 'not supplied')}.`,
    `Verified (from DB): recorded LLM modes: ${report.llm.modes.map(cell).join(', ') || 'none; this does not prove rules mode'}.`,
    `Source duration (ms): ${v(report.durationMs)}.`,
    '',
    'Timing uses finished_at minus started_at for each attempt, including retries. Sum can double-count overlapping work; max is the longest single attempt. Unfinished attempts are excluded from sums. Elapsed covers first attempt start to last attempt finish, including gaps, and is unknown while attempts are unfinished. This is not total workflow latency or ingest/ASR time.',
    '',
    '| Stage | Attempts | Failed/timed out | Unfinished | Sum ms | Max ms |',
    '|---|---|---|---|---|---|',
    ...[...report.stages, { jobName: 'TOTAL', ...report.totals }].map(
      (s) =>
        `| ${cell(s.jobName)} | ${v(s.attempts)} | ${v(s.failures)} | ${v(s.incomplete)} | ${v(s.sumMs)} | ${v(s.maxMs)} |`,
    ),
    '',
    `Attempt envelope elapsed (ms): ${v(report.totals.elapsedMs)}.`,
    '',
    '| LLM metric | Total | Per hour of source video |',
    '|---|---|---|',
    `| Recorded calls | ${v(report.llm.calls)} | ${v(report.llm.perHour.calls)} |`,
    `| Input tokens (uncached) | ${v(report.llm.inputTokens)} | ${v(report.llm.perHour.inputTokens)} |`,
    `| Input tokens (cache read) | ${v(report.llm.cacheReadTokens)} | ${v(report.llm.perHour.cacheReadTokens)} |`,
    `| Input tokens (cache write) | ${v(report.llm.cacheWriteTokens)} | ${v(report.llm.perHour.cacheWriteTokens)} |`,
    `| Output tokens | ${v(report.llm.outputTokens)} | ${v(report.llm.perHour.outputTokens)} |`,
    `| USD — estimate (list price) | ${v(report.llm.costUsdEstimate)} | ${v(report.llm.perHour.costUsdEstimate)} |`,
    '',
    `Calls missing a cost estimate: ${v(report.llm.missingCostCalls)}.`,
    'Cost is the sum of stored cost_usd_estimate, an estimate (list price), not a bill. A missing estimate makes total cost unknown. Calls include errors and repair attempts; cache hits create no llm_calls row. Tokens are recorded usage only; failed calls may have unreported usage.',
    '',
    `All suggestion rows: ${v(report.clips.count)}. Final ready clips: ${v(report.clips.finalCount)}.`,
    `Ready clip length (ms): min ${v(report.clips.minMs)}; max ${v(report.clips.maxMs)}; mean ${v(report.clips.meanMs)}; sum ${v(report.clips.totalMs)}.`,
    '',
    'Assumption: final clips means status ready at snapshot time; planned, failed and discarded rows are excluded. Rank ascending determines evaluation order. Precision uses the existing evaluator default overlap threshold, grades usable and strong, and a fixed top-five denominator (missing clips are misses).',
    '',
  ];
  if (meta.labels) {
    lines.push(
      `Labels supplied by: ${cell(meta.labels.labelled_by)}. ${meta.labels.labelled_by === 'agent' ? 'Assumption: agent-drafted labels, not human-confirmed ground truth.' : 'Label provenance is operator supplied, not verified by the database.'}`,
    );
    lines.push(
      '| Mode (DB) | Minimum grade (evaluation setting) | k (evaluation setting) | Hits | Precision |',
      '|---|---|---|---|---|',
    );
    for (const p of report.precision ?? [])
      lines.push(
        `| ${cell(p.mode)} | ${p.grade} | ${p.k} | Verified (DB clips + supplied labels): ${p.hits} | Verified (DB clips + supplied labels): ${p.precision} |`,
      );
    if (!report.precision?.length)
      lines.push('Unknown: no clip mode recorded; no per-mode precision can be attributed.');
  } else lines.push('Precision: not evaluated (no labels supplied).');
  lines.push(
    '',
    'Failures and cancellations (Verified from DB; credential-like text redacted):',
    '',
    '| Location | Status | Error |',
    '|---|---|---|',
  );
  for (const f of report.failures)
    lines.push(`| ${cell(f.location)} | ${cell(f.status)} | ${cell(f.error)} |`);
  if (meta.runError) lines.push(`| Workflow | ${cell(meta.status)} | ${cell(errorText(meta.runError))} |`);
  if (!report.failures.length && !meta.runError) lines.push('No failures recorded in the selected rows.');
  return `${lines.join('\n')}\n`;
}
