import type { TimingList, TimingRun } from '@myvideo/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

type RunRow = {
  id: string;
  kind: TimingRun['kind'];
  status: TimingRun['status'];
  subject_type: string | null;
  subject_id: string | null;
  input: Record<string, unknown> | null;
  created_at: Date;
  finished_at: Date | null;
  source_title: string | null;
  source_duration_ms: string | number | null;
  project_title: string | null;
};
type JobRow = {
  workflow_run_id: string;
  type: string;
  status: string;
  attempts: number;
  step_index: number;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
};
type LlmRow = {
  workflow_run_id: string;
  calls: string;
  total_ms: string;
  input_tokens: string;
  output_tokens: string;
  cost_usd: number | null;
  has_cost: boolean;
  modes: string[];
  models: string[];
};

const diff = (a: Date | null, b: Date | null) => (a && b ? Math.max(0, b.getTime() - a.getTime()) : null);
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

/** The upload facts the API writes into an ingest run's input (see SourcesService.finalizeUpload). */
export function readUpload(input: Record<string, unknown> | null): TimingRun['upload'] {
  const u = input?.upload as Record<string, unknown> | undefined;
  if (!u) return null;
  const started = Date.parse(String(u.startedAt));
  const received = Date.parse(String(u.receivedAt));
  const stored = Date.parse(String(u.storedAt));
  const bytes = Number(u.bytes);
  if ([started, received, stored, bytes].some((n) => Number.isNaN(n))) return null;
  return {
    startedAt: new Date(started).toISOString(),
    receivedAt: new Date(received).toISOString(),
    storedAt: new Date(stored).toISOString(),
    bytes,
    uploadMs: Math.max(0, received - started),
    storeMs: Math.max(0, stored - received),
  };
}

/**
 * Measured durations of recent runs for the "timings" page (presentation numbers). Everything comes from rows the
 * job system already writes: run/job timestamps, the upload facts on ingest runs, and the model-call log.
 * Merchant-scoped in every query (AGENTS §8.7).
 */
@Injectable()
export class TimingsService {
  constructor(@Inject(DataSource) private readonly ds: DataSource) {}

  async list(merchantId: string, limit: number, now = new Date()): Promise<TimingList> {
    const runs: RunRow[] = await this.ds.query(
      `SELECT r.id, r.kind, r.status, r.subject_type, r.subject_id, r.input, r.created_at, r.finished_at,
              s.title AS source_title, (s.probe->>'durationMs') AS source_duration_ms, p.title AS project_title
         FROM workflow_runs r
         LEFT JOIN video_sources s
           ON r.subject_type = 'source' AND s.id = r.subject_id AND s.merchant_id = r.merchant_id
         LEFT JOIN projects p
           ON r.subject_type = 'project' AND p.id = r.subject_id AND p.merchant_id = r.merchant_id
        WHERE r.merchant_id = $1 AND r.kind <> 'system_test'
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT $2`,
      [merchantId, limit],
    );
    if (runs.length === 0) return { items: [] };
    const ids = runs.map((r) => r.id);
    const jobs: JobRow[] = await this.ds.query(
      `SELECT workflow_run_id, type, status, attempts, step_index, created_at, started_at, finished_at
         FROM jobs WHERE merchant_id = $1 AND workflow_run_id = ANY($2::uuid[])
        ORDER BY step_index, created_at`,
      [merchantId, ids],
    );
    const llm: LlmRow[] = await this.ds.query(
      `SELECT workflow_run_id, count(*) AS calls, coalesce(sum(duration_ms), 0) AS total_ms,
              coalesce(sum(input_tokens + cache_read_tokens + cache_write_tokens), 0) AS input_tokens,
              coalesce(sum(output_tokens), 0) AS output_tokens,
              sum(cost_usd_estimate) AS cost_usd, bool_or(cost_usd_estimate IS NOT NULL) AS has_cost,
              array_agg(DISTINCT mode) AS modes, array_agg(DISTINCT model) AS models
         FROM llm_calls WHERE merchant_id = $1 AND workflow_run_id = ANY($2::uuid[])
        GROUP BY workflow_run_id`,
      [merchantId, ids],
    );
    const llmBy = new Map(llm.map((l) => [l.workflow_run_id, l]));
    const items = runs.map((r): TimingRun => {
      const l = llmBy.get(r.id);
      const durMs = r.source_duration_ms == null ? null : Number(r.source_duration_ms);
      return {
        runId: r.id,
        kind: r.kind,
        status: r.status,
        subjectType: r.subject_type,
        subjectId: r.subject_id,
        subjectTitle: r.source_title ?? r.project_title ?? null,
        mediaSeconds: durMs != null && Number.isFinite(durMs) ? durMs / 1000 : null,
        createdAt: r.created_at.toISOString(),
        finishedAt: isoOrNull(r.finished_at),
        totalMs: diff(r.created_at, r.finished_at ?? now) ?? 0,
        upload: readUpload(r.input),
        steps: jobs
          .filter((j) => j.workflow_run_id === r.id)
          .map((j) => ({
            type: j.type,
            status: j.status,
            attempts: j.attempts,
            createdAt: j.created_at.toISOString(),
            startedAt: isoOrNull(j.started_at),
            finishedAt: isoOrNull(j.finished_at),
            waitMs: diff(j.created_at, j.started_at),
            runMs: j.started_at ? diff(j.started_at, j.finished_at ?? now) : null,
          })),
        llm: l
          ? {
              calls: Number(l.calls),
              totalMs: Number(l.total_ms),
              inputTokens: Number(l.input_tokens),
              outputTokens: Number(l.output_tokens),
              costUsd: l.has_cost && l.cost_usd != null ? Number(l.cost_usd) : null,
              modes: l.modes,
              models: l.models,
            }
          : null,
      };
    });
    return { items };
  }
}
