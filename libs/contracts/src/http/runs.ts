import { RUN_STATUSES, WORKFLOW_KINDS } from '@myvideo/domain';
import { z } from 'zod';
import { named } from '../registry.js';
import { defineRoute } from '../route.js';
import { ApiErrorBody } from './errors.js';
import { JobSummary } from './jobs.js';

export const RunSummary = named(
  'RunSummary',
  z.object({
    id: z.uuid(),
    kind: z.enum(WORKFLOW_KINDS),
    status: z.enum(RUN_STATUSES),
    subjectType: z.string().nullable(),
    subjectId: z.uuid().nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    finishedAt: z.iso.datetime({ offset: true }).nullable(),
    jobs: z.array(JobSummary),
  }),
);
export type RunSummary = z.infer<typeof RunSummary>;

export const RunList = named(
  'RunList',
  z.object({ items: z.array(RunSummary), nextCursor: z.string().nullable() }),
  'Newest first; pass nextCursor as `before` for the next page',
);
export type RunList = z.infer<typeof RunList>;

/** One SSE message on /workflow-runs/{id}/events (`event:` is `job` or `run`, `id:` is `id`). */
export const RunEvent = named(
  'RunEvent',
  z.object({
    id: z.string(),
    kind: z.enum(['job', 'run']),
    runId: z.uuid(),
    jobId: z.uuid().nullable(),
    status: z.string(),
    progress: z.number().nullable(),
    at: z.iso.datetime({ offset: true }),
  }),
);
export type RunEvent = z.infer<typeof RunEvent>;

export const TestRunRequest = named(
  'TestRunRequest',
  z.object({
    ms: z.number().int().min(100).max(120_000).default(5000),
    steps: z.number().int().min(1).max(100).default(10),
    /** First attempt fails fatally (→ dead) so retry can be tried from the UI. */
    failFirstAttempt: z.boolean().default(false),
  }),
);

export const RunIdParams = z.object({ id: z.uuid() });
export const ListRunsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.string().max(200).optional(),
});

export const listRuns = defineRoute({
  operationId: 'listRuns',
  method: 'get',
  path: '/workflow-runs',
  summary: 'Workflow runs of the signed-in merchant with their jobs, newest first',
  tags: ['jobs'],
  auth: true,
  request: { query: ListRunsQuery },
  responses: { 200: { description: 'A page of runs', schema: RunList } },
});

export const getRun = defineRoute({
  operationId: 'getRun',
  method: 'get',
  path: '/workflow-runs/{id}',
  summary: 'One run with its jobs',
  tags: ['jobs'],
  auth: true,
  request: { params: RunIdParams },
  responses: {
    200: { description: 'The run', schema: RunSummary },
    404: { description: 'No such run for this merchant', schema: ApiErrorBody },
  },
});

export const runEvents = defineRoute({
  operationId: 'runEvents',
  method: 'get',
  path: '/workflow-runs/{id}/events',
  summary:
    'Server-Sent Events: `job`/`run` events (data = RunEvent) in order, then `end` when the run finishes. Send Last-Event-ID to resume.',
  tags: ['jobs'],
  auth: true,
  request: { params: RunIdParams },
  responses: {
    200: { description: 'text/event-stream of RunEvent' },
    404: { description: 'No such run for this merchant', schema: ApiErrorBody },
  },
});

export const createTestRun = defineRoute({
  operationId: 'createTestRun',
  method: 'post',
  path: '/workflow-runs/test',
  summary: 'Start a diagnostic run (one system.sleep job) to check the job system end to end',
  tags: ['jobs'],
  auth: true,
  request: { body: TestRunRequest },
  responses: {
    201: { description: 'Run created', schema: RunSummary },
    429: { description: 'Too many unfinished runs for this merchant (back-pressure)', schema: ApiErrorBody },
  },
});
