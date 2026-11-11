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

export const AssetParams = z.object({
  id: z.uuid(),
  kind: z.enum(['original', 'proxy', 'audio', 'peaks', 'sprites']),
});

export const getSourceAsset = defineRoute({
  operationId: 'getSourceAsset',
  method: 'get',
  path: '/sources/{id}/assets/{kind}',
  summary: 'Stream a file of the source (supports HTTP Range for video seeking). Merchant-scoped.',
  tags: ['sources'],
  auth: true,
  request: { params: AssetParams },
  responses: {
    200: { description: 'Whole file' },
    206: { description: 'Requested byte range' },
    404: { description: 'No such source or file for this merchant', schema: ApiErrorBody },
    416: { description: 'Range not satisfiable', schema: ApiErrorBody },
  },
});

export const SpriteSheetParams = z.object({
  id: z.uuid(),
  sheet: z.coerce.number().int().min(0).max(10_000),
});

export const getSpriteSheet = defineRoute({
  operationId: 'getSpriteSheet',
  method: 'get',
  path: '/sources/{id}/sprites/{sheet}',
  summary:
    'One thumbnail sprite sheet (JPEG, 10×10 tiles, 1 tile per second); the index is /sources/{id}/assets/sprites',
  tags: ['sources'],
  auth: true,
  request: { params: SpriteSheetParams },
  responses: {
    200: { description: 'JPEG image' },
    404: { description: 'No such sheet for this merchant', schema: ApiErrorBody },
  },
});

export const UploadConfig = named(
  'UploadConfig',
  z.object({
    /** tus endpoint, relative to the API base. */
    endpoint: z.string(),
    maxBytes: z.number().int(),
    extensions: z.array(z.string()),
    chunkBytes: z.number().int(),
  }),
);
export type UploadConfig = z.infer<typeof UploadConfig>;

export const getUploadConfig = defineRoute({
  operationId: 'getUploadConfig',
  method: 'get',
  path: '/sources/upload-config',
  summary: 'Limits the upload UI checks before sending (the server enforces them again)',
  tags: ['sources'],
  auth: true,
  responses: { 200: { description: 'Upload limits', schema: UploadConfig } },
});
