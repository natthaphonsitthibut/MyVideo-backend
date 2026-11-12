import { RUN_STATUSES, WORKFLOW_KINDS } from '@myvideo/domain';
import { z } from 'zod';
import { named } from '../registry.js';
import { defineRoute } from '../route.js';

const iso = z.iso.datetime({ offset: true });

/** One step (job) of a run with measured times. `waitMs` = created → started (queue), `runMs` = started → finished. */
export const TimingStep = named(
  'TimingStep',
  z.object({
    type: z.string(),
    status: z.string(),
    attempts: z.number().int(),
    createdAt: iso,
    startedAt: iso.nullable(),
    finishedAt: iso.nullable(),
    waitMs: z.number().int().nullable(),
    runMs: z.number().int().nullable(),
  }),
);
export type TimingStep = z.infer<typeof TimingStep>;

/** Upload of the original file (tus): client upload, then copy into storage. Only on ingest runs recorded after 2026-11-13. */
export const TimingUpload = named(
  'TimingUpload',
  z.object({
    startedAt: iso,
    receivedAt: iso,
    storedAt: iso,
    bytes: z.number().int(),
    uploadMs: z.number().int(),
    storeMs: z.number().int(),
  }),
);

/** Language-model calls made by the run (from the call log; cached answers cost nothing). */
export const TimingLlm = named(
  'TimingLlm',
  z.object({
    calls: z.number().int(),
    totalMs: z.number().int(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    costUsd: z.number().nullable(),
    modes: z.array(z.string()),
    models: z.array(z.string()),
  }),
);

export const TimingRun = named(
  'TimingRun',
  z.object({
    runId: z.uuid(),
    kind: z.enum(WORKFLOW_KINDS),
    status: z.enum(RUN_STATUSES),
    subjectType: z.string().nullable(),
    subjectId: z.uuid().nullable(),
    /** Title of the video (source) or clip (project) the run worked on; null when it was deleted. */
    subjectTitle: z.string().nullable(),
    /** Length of the source video in seconds, when known (ingest / transcribe / live-to-clips runs). */
    mediaSeconds: z.number().nullable(),
    createdAt: iso,
    finishedAt: iso.nullable(),
    /** created → finished (or now, while running). */
    totalMs: z.number().int(),
    upload: TimingUpload.nullable(),
    steps: z.array(TimingStep),
    llm: TimingLlm.nullable(),
  }),
);
export type TimingRun = z.infer<typeof TimingRun>;

export const TimingList = named('TimingList', z.object({ items: z.array(TimingRun) }), 'Newest first');
export type TimingList = z.infer<typeof TimingList>;

export const ListTimingsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const listTimings = defineRoute({
  operationId: 'listTimings',
  method: 'get',
  path: '/timings',
  summary:
    'Measured durations of recent workflow runs (upload, each processing step, model calls), newest first',
  tags: ['jobs'],
  auth: true,
  request: { query: ListTimingsQuery },
  responses: { 200: { description: 'Recent runs with timings', schema: TimingList } },
});
