import { JOB_STATUSES, QUEUES } from '@myvideo/domain';
import { z } from 'zod';
import { named } from '../registry.js';
import { defineRoute } from '../route.js';
import { ApiErrorBody } from './errors.js';

export const JobError = named(
  'JobError',
  z.object({
    message: z.string(),
    name: z.string(),
    fatal: z.boolean(),
    attempt: z.number().int(),
    at: z.string(),
  }),
);

export const JobSummary = named(
  'JobSummary',
  z.object({
    id: z.uuid(),
    workflowRunId: z.uuid(),
    type: z.string(),
    queue: z.enum(QUEUES),
    stepIndex: z.number().int(),
    status: z.enum(JOB_STATUSES),
    attempts: z.number().int(),
    maxAttempts: z.number().int(),
    progress: z.number().min(0).max(1),
    cancelRequested: z.boolean(),
    error: JobError.nullable(),
    runAfter: z.iso.datetime({ offset: true }),
    createdAt: z.iso.datetime({ offset: true }),
    startedAt: z.iso.datetime({ offset: true }).nullable(),
    finishedAt: z.iso.datetime({ offset: true }).nullable(),
  }),
);
export type JobSummary = z.infer<typeof JobSummary>;

export const JobIdParams = z.object({ id: z.uuid() });

export const cancelJob = defineRoute({
  operationId: 'cancelJob',
  method: 'post',
  path: '/jobs/{id}/cancel',
  summary: 'Cancel a job: waiting jobs stop at once, a running job is asked to stop (its process is killed)',
  tags: ['jobs'],
  auth: true,
  request: { params: JobIdParams },
  responses: {
    200: {
      description: 'Cancelled, or cancel requested (cancelRequested: true while it stops)',
      schema: JobSummary,
    },
    404: { description: 'No such job for this merchant', schema: ApiErrorBody },
    409: { description: 'Job already finished', schema: ApiErrorBody },
  },
});

export const retryJob = defineRoute({
  operationId: 'retryJob',
  method: 'post',
  path: '/jobs/{id}/retry',
  summary: 'Retry a dead or cancelled job (gives it a fresh attempt budget)',
  tags: ['jobs'],
  auth: true,
  request: { params: JobIdParams },
  responses: {
    200: { description: 'Job is pending again', schema: JobSummary },
    404: { description: 'No such job for this merchant', schema: ApiErrorBody },
    409: { description: 'Job is not dead or cancelled', schema: ApiErrorBody },
  },
});
