import { z } from 'zod';
import { named } from '../registry.js';
import { defineRoute } from '../route.js';
import { ApiErrorBody } from './errors.js';
export const ReferenceGrammar = z.object({
  durationMs: z.number().positive(),
  cutsMs: z.array(z.number().int().nonnegative()),
  medianShotMs: z.number().positive(),
  colours: z.array(z.string().regex(/^#[0-9a-f]{6}$/)).max(6),
  captionBand: z.number().min(0).max(1).nullable(),
  textSamples: z
    .array(z.object({ atMs: z.number(), y: z.number().min(0).max(1), height: z.number().min(0).max(1) }))
    .max(30),
  textSamplePeriodMs: z.number().positive(),
  visionStatus: z.enum(['measured', 'unavailable', 'not_run']),
  rhythm: z
    .object({
      bpm: z.number().nullable(),
      confidence: z.number(),
      firstBeatSec: z.number().nullable(),
      beatsSec: z.array(z.number()),
      dropsSec: z.array(z.number()),
    })
    .nullable(),
});
export type ReferenceGrammar = z.infer<typeof ReferenceGrammar>;
export const ReferenceStyleRecord = named(
  'ReferenceStyleRecord',
  z.object({
    id: z.uuid(),
    sourceId: z.uuid(),
    title: z.string(),
    status: z.enum(['waiting', 'processing', 'ready', 'failed']),
    sourceStatus: z.string(),
    styleId: z.string().nullable(),
    grammar: ReferenceGrammar.nullable(),
    error: z.string().nullable(),
  }),
);
export const ReferenceStyleList = named(
  'ReferenceStyleList',
  z.object({ items: z.array(ReferenceStyleRecord) }),
);
export const ReferenceCreateBody = named(
  'ReferenceCreateBody',
  z.object({ sourceId: z.uuid(), title: z.string().trim().min(1).max(100) }),
);
export const ReferenceParams = z.object({ id: z.uuid() });
const error = { description: 'Reference not available', schema: ApiErrorBody };
export const referenceStylesRoutes = [
  defineRoute({
    operationId: 'lockReferenceStyle',
    method: 'post',
    path: '/reference-styles/{id}/lock',
    summary: 'Lock a measured merchant reference recipe for future edits',
    tags: ['styles'],
    auth: true,
    request: { params: ReferenceParams },
    responses: { 204: { description: 'Style locked' }, 404: error, 409: error },
  }),
  defineRoute({
    operationId: 'listReferenceStyles',
    method: 'get',
    path: '/reference-styles',
    summary: 'Merchant reference clips, never editing footage',
    tags: ['styles'],
    auth: true,
    responses: { 200: { description: 'References', schema: ReferenceStyleList } },
  }),
  defineRoute({
    operationId: 'createReferenceStyle',
    method: 'post',
    path: '/reference-styles',
    summary: 'Mark an unused uploaded clip as reference and measure its editing grammar',
    tags: ['styles'],
    auth: true,
    request: { body: ReferenceCreateBody },
    responses: {
      202: { description: 'Queued reference', schema: ReferenceStyleRecord },
      404: error,
      409: error,
    },
  }),
  defineRoute({
    operationId: 'retryReferenceStyle',
    method: 'post',
    path: '/reference-styles/{id}/retry',
    summary: 'Retry a failed reference measurement',
    tags: ['styles'],
    auth: true,
    request: { params: ReferenceParams },
    responses: {
      202: { description: 'Queued reference', schema: ReferenceStyleRecord },
      404: error,
      409: error,
    },
  }),
];
