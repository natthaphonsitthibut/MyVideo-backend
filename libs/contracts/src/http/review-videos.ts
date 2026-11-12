import { z } from 'zod';
import { SHOT_ROLES, TemplateVersion } from '../project/templates.js';
import { named } from '../registry.js';
import { defineRoute } from '../route.js';
import { ApiErrorBody } from './errors.js';

const text = (max: number) =>
  z
    .string()
    .transform((s) => s.normalize('NFC').trim())
    .pipe(z.string().max(max));

export const ReviewProduct = named(
  'ReviewProduct',
  z.object({
    /** The merchant's product name (shown as the opening title). */
    name: text(80),
    /** The merchant's own selling points (shown as labels, in order; never invented). */
    points: z.array(text(60)).max(4),
  }),
);

export const CreateReviewVideoBody = named(
  'CreateReviewVideoBody',
  z.object({
    sourceIds: z.array(z.uuid()).min(1).max(8),
    templateId: z.string().min(1).max(40),
    product: ReviewProduct,
    /** Roles the merchant picked: key `${sourceId}:${shotSeq}`. */
    roles: z.record(z.string().max(80), z.enum(SHOT_ROLES)).optional(),
  }),
);

export const SwapTemplateBody = named(
  'SwapTemplateBody',
  z.object({ templateId: z.string().min(1).max(40) }),
);

export const ReviewShot = named(
  'ReviewShot',
  z.object({
    sourceId: z.uuid(),
    seq: z.number().int(),
    startMs: z.number().int(),
    endMs: z.number().int(),
    role: z.enum(SHOT_ROLES),
    confidence: z.number(),
    reason: z.string(),
    chosenByMerchant: z.boolean(),
    needsChoice: z.boolean(),
  }),
);

export const ReviewVideoState = named(
  'ReviewVideoState',
  z.object({
    runId: z.uuid(),
    status: z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled']),
    templateId: z.string(),
    sourceIds: z.array(z.uuid()),
    product: ReviewProduct,
    /** null while the clips are still analysed. */
    result: z
      .object({
        status: z.enum(['ready', 'missing']),
        projectId: z.uuid().nullable(),
        /** What to shoot when the footage does not fit (slot −1 = too short overall). */
        missing: z.array(
          z.object({ slot: z.number().int(), roles: z.array(z.enum(SHOT_ROLES)), hint: z.string() }),
        ),
        shots: z.array(ReviewShot),
      })
      .nullable(),
    error: z.string().nullable(),
  }),
);
export type ReviewVideoState = z.infer<typeof ReviewVideoState>;

const IdParams = z.object({ id: z.uuid() });
export const TemplateList = named('TemplateList', z.object({ items: z.array(TemplateVersion) }));

export const listTemplates = defineRoute({
  operationId: 'listTemplates',
  method: 'get',
  path: '/templates',
  summary: 'Templates the merchant can pick (newest version of each)',
  tags: ['templates'],
  auth: true,
  responses: { 200: { description: 'Templates', schema: TemplateList } },
});

export const createReviewVideo = defineRoute({
  operationId: 'createReviewVideo',
  method: 'post',
  path: '/review-videos',
  summary: 'Make a product video from several phone clips with a template',
  tags: ['templates'],
  auth: true,
  request: { body: CreateReviewVideoBody },
  responses: {
    202: { description: 'Started', schema: ReviewVideoState },
    400: { description: 'Unknown template or invalid body', schema: ApiErrorBody },
    404: { description: 'A video does not exist', schema: ApiErrorBody },
    409: { description: 'A video is still processing', schema: ApiErrorBody },
  },
});

export const getReviewVideo = defineRoute({
  operationId: 'getReviewVideo',
  method: 'get',
  path: '/review-videos/{id}',
  summary: 'Progress and result of a review video run (project, or what footage is missing)',
  tags: ['templates'],
  auth: true,
  request: { params: IdParams },
  responses: {
    200: { description: 'State', schema: ReviewVideoState },
    404: { description: 'No such run', schema: ApiErrorBody },
  },
});

export const swapTemplate = defineRoute({
  operationId: 'swapTemplate',
  method: 'post',
  path: '/projects/{id}/template',
  summary: 'Apply another template to the same footage as a new version of the project',
  tags: ['templates'],
  auth: true,
  request: { params: IdParams, body: SwapTemplateBody },
  responses: {
    202: { description: 'Started', schema: ReviewVideoState },
    400: { description: 'Unknown template / project not made from a template', schema: ApiErrorBody },
    404: { description: 'No such project', schema: ApiErrorBody },
  },
});
