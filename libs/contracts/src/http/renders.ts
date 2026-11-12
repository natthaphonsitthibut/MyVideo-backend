import { RENDER_PRESETS } from '@myvideo/domain';
import { z } from 'zod';
import { named } from '../registry.js';
import { defineRoute } from '../route.js';
import { ApiErrorBody } from './errors.js';
import { ProjectIdParams } from './projects.js';

export const RenderStatus = z.enum(['queued', 'rendering', 'ready', 'failed', 'cancelled']);

export const RenderSummary = named(
  'RenderSummary',
  z.object({
    id: z.uuid(),
    projectId: z.uuid(),
    projectTitle: z.string(),
    projectVersion: z.number().int().min(1),
    preset: z.enum(RENDER_PRESETS),
    /** From the render run: queued → rendering → ready | failed | cancelled. */
    status: RenderStatus,
    /** 0..1 while rendering. */
    progress: z.number().min(0).max(1),
    /** The run that renders it (live progress: `/workflow-runs/{runId}/events`). */
    runId: z.uuid().nullable(),
    /** Merchant-readable reason when failed (Thai). */
    error: z.string().nullable(),
    sizeBytes: z.number().int().nullable(),
    durationMs: z.number().int().nullable(),
    createdAt: z.iso.datetime({ offset: true }),
    finishedAt: z.iso.datetime({ offset: true }).nullable(),
  }),
);
export type RenderSummary = z.infer<typeof RenderSummary>;

export const RenderList = named('RenderList', z.object({ items: z.array(RenderSummary) }));

export const RequestRenderBody = named(
  'RequestRenderBody',
  z.object({
    preset: z.enum(RENDER_PRESETS).default('standard'),
    /** Version to render; default = the current version. */
    version: z.number().int().min(1).optional(),
  }),
);

export const RenderIdParams = z.object({ id: z.uuid() });
export const RenderFileQuery = z.object({ download: z.enum(['0', '1']).optional() });

const notFound = { description: 'No such project/render for this merchant', schema: ApiErrorBody };

export const requestRender = defineRoute({
  operationId: 'requestRender',
  method: 'post',
  path: '/projects/{id}/renders',
  summary:
    'Export a project version to MP4. Idempotent per (version, preset, stage version): an existing render is returned (and a failed/cancelled one is started again)',
  tags: ['renders'],
  auth: true,
  request: { params: ProjectIdParams, body: RequestRenderBody },
  responses: {
    200: { description: 'The render (new, in progress, or already done)', schema: RenderSummary },
    404: notFound,
    429: { description: 'Too many unfinished runs', schema: ApiErrorBody },
  },
});

export const listProjectRenders = defineRoute({
  operationId: 'listProjectRenders',
  method: 'get',
  path: '/projects/{id}/renders',
  summary: 'Renders of a project, newest first',
  tags: ['renders'],
  auth: true,
  request: { params: ProjectIdParams },
  responses: { 200: { description: 'Renders', schema: RenderList }, 404: notFound },
});

export const listRenders = defineRoute({
  operationId: 'listRenders',
  method: 'get',
  path: '/renders',
  summary: 'The merchant’s latest renders (50), newest first',
  tags: ['renders'],
  auth: true,
  responses: { 200: { description: 'Renders', schema: RenderList } },
});

export const getRender = defineRoute({
  operationId: 'getRender',
  method: 'get',
  path: '/renders/{id}',
  summary: 'One render',
  tags: ['renders'],
  auth: true,
  request: { params: RenderIdParams },
  responses: { 200: { description: 'The render', schema: RenderSummary }, 404: notFound },
});

export const getRenderFile = defineRoute({
  operationId: 'getRenderFile',
  method: 'get',
  path: '/renders/{id}/file',
  summary: 'The MP4 (authorised, byte ranges); `download=1` sends it as an attachment',
  tags: ['renders'],
  auth: true,
  request: { params: RenderIdParams, query: RenderFileQuery },
  responses: {
    200: { description: 'video/mp4' },
    206: { description: 'Partial content' },
    404: notFound,
    409: { description: 'Not rendered yet', schema: ApiErrorBody },
  },
});
