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
    /** From the probe step (null until probed). */
    durationMs: z.number().int().nullable(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    hasAudio: z.boolean().nullable(),
    /** Project frame rate of this source (VFR normalised to 30 fps) and its length in those frames. */
    fps: z.object({ num: z.number().int().positive(), den: z.number().int().positive() }).nullable(),
    durationFrames: z.number().int().nullable(),
    /** Which derived files exist (the UI shows what is ready). */
    hasProxy: z.boolean(),
    hasPeaks: z.boolean(),
    sprites: z
      .object({
        version: z.literal(1),
        intervalSec: z.number(),
        cols: z.number().int(),
        rows: z.number().int(),
        tileWidth: z.number().int(),
        tileHeight: z.number().int(),
        count: z.number().int(),
        sheets: z.number().int(),
        durationMs: z.number().int(),
      })
      .nullable(),
  }),
);

export const SourceList = named(
  'SourceList',
  z.object({ items: z.array(SourceSummary), nextCursor: z.string().nullable() }),
);
export type SourceList = z.infer<typeof SourceList>;

export const ListSourcesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  before: z.string().max(200).optional(),
});

export const listSources = defineRoute({
  operationId: 'listSources',
  method: 'get',
  path: '/sources',
  summary: 'Uploaded videos of the signed-in merchant, newest first',
  tags: ['sources'],
  auth: true,
  request: { query: ListSourcesQuery },
  responses: { 200: { description: 'A page of sources', schema: SourceList } },
});
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

/** What else goes when a source is deleted (projects whose document uses it). */
export const SourceDependents = named(
  'SourceDependents',
  z.object({ projects: z.array(z.object({ id: z.uuid(), title: z.string() })) }),
);
export type SourceDependents = z.infer<typeof SourceDependents>;

export const getSourceDependents = defineRoute({
  operationId: 'getSourceDependents',
  method: 'get',
  path: '/sources/{id}/dependents',
  summary: 'Projects that use this source (they are deleted with it, after the merchant confirms)',
  tags: ['sources'],
  auth: true,
  request: { params: SourceIdParams },
  responses: {
    200: { description: 'Projects using the source', schema: SourceDependents },
    404: { description: 'No such source for this merchant', schema: ApiErrorBody },
  },
});

export const DeleteSourceQuery = z.object({
  /** Must be true when projects use the source (the merchant confirmed deleting them too). */
  withProjects: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export const deleteSource = defineRoute({
  operationId: 'deleteSource',
  method: 'delete',
  path: '/sources/{id}',
  summary:
    'Delete an uploaded video, its derived files and analyses (and, with withProjects=true, the projects using it). ' +
    'Running work for it is cancelled; files are removed by a retry-safe job. Idempotent: an unknown id is 204.',
  tags: ['sources'],
  auth: true,
  request: { params: SourceIdParams, query: DeleteSourceQuery },
  responses: {
    204: { description: 'Deleted (or already gone)' },
    409: { description: 'Projects use this source; repeat with withProjects=true', schema: ApiErrorBody },
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
