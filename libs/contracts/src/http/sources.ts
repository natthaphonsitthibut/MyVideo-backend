import { SOURCE_STATUSES } from '@myvideo/domain';
import { z } from 'zod';
import { named } from '../registry.js';
import { defineRoute } from '../route.js';
import { ApiErrorBody } from './errors.js';

export const SourceSummary = named(
  'SourceSummary',
  z.object({
    id: z.uuid(),
    title: z.string(),
    originalFilename: z.string(),
    status: z.enum(SOURCE_STATUSES),
    sizeBytes: z.number().int(),
    failureReason: z.string().nullable(),
    /** The ingest run (live progress via /workflow-runs/{id}/events). */
    ingestRunId: z.uuid().nullable(),
    createdAt: z.iso.datetime({ offset: true }),
  }),
);
export type SourceSummary = z.infer<typeof SourceSummary>;

export const UploadIdParams = z.object({ uploadId: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/) });
export const SourceIdParams = z.object({ id: z.uuid() });

export const getSourceByUpload = defineRoute({
  operationId: 'getSourceByUpload',
  method: 'get',
  path: '/sources/by-upload/{uploadId}',
  summary:
    'The source created from a finished resumable upload (tus at /uploads). Idempotent: finishes the hand-over if it was interrupted.',
  tags: ['sources'],
  auth: true,
  request: { params: UploadIdParams },
  responses: {
    200: { description: 'The source', schema: SourceSummary },
    404: { description: 'No such upload for this merchant', schema: ApiErrorBody },
    409: { description: 'Upload not finished yet', schema: ApiErrorBody },
  },
});

export const getSource = defineRoute({
  operationId: 'getSource',
  method: 'get',
  path: '/sources/{id}',
  summary: 'One uploaded video',
  tags: ['sources'],
  auth: true,
  request: { params: SourceIdParams },
  responses: {
    200: { description: 'The source', schema: SourceSummary },
    404: { description: 'No such source for this merchant', schema: ApiErrorBody },
  },
});
