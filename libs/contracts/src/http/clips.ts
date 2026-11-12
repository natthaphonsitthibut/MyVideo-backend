import { z } from 'zod';
import { named } from '../registry.js';
import { defineRoute } from '../route.js';
import { ApiErrorBody } from './errors.js';
import { SourceIdParams } from './sources.js';

export const ClipSuggestion = named(
  'ClipSuggestion',
  z.object({
    id: z.uuid(),
    rank: z.number().int(),
    /** planned → ready (its project exists) | failed; discarded by the merchant. */
    status: z.enum(['planned', 'ready', 'failed', 'discarded']),
    /** Cut on the source timeline (ms). */
    startMs: z.number().int(),
    endMs: z.number().int(),
    /** 0–100: the model's score (LLM modes) or the rule score scaled to the best clip of the run (rules mode). */
    score: z.number(),
    /** product-intro | demo | price-promo | faq | testimonial | other */
    type: z.string(),
    reason: z.string(),
    /** The seller's words that back the reason (LLM modes); null in rules mode. */
    quote: z.string().nullable(),
    hook: z.string().nullable(),
    title: z.string(),
    /** Who chose the clip. */
    origin: z.enum(['rules', 'llm']),
    projectId: z.uuid().nullable(),
    /** Thai, merchant-readable, when status is failed. */
    error: z.string().nullable(),
  }),
);
export type ClipSuggestion = z.infer<typeof ClipSuggestion>;

export const ClipsState = named(
  'ClipsState',
  z.object({
    /** The newest live-to-clips run of the source (null = never generated). */
    runId: z.uuid().nullable(),
    status: z.enum(['none', 'pending', 'running', 'succeeded', 'failed', 'cancelled']),
    /** Analysis mode of that run: api | local-agent | rules. */
    mode: z.string().nullable(),
    clips: z.array(ClipSuggestion),
  }),
);
export type ClipsState = z.infer<typeof ClipsState>;

export const GenerateClipsBody = named(
  'GenerateClipsBody',
  z.object({
    /** Merchant-provided product name (used in titles; never invented). */
    productName: z
      .string()
      .transform((s) => s.normalize('NFC').trim())
      .pipe(z.string().max(80))
      .optional(),
    /** Start a new run even if a finished one exists (regenerate). */
    fresh: z.boolean().optional(),
  }),
);

export const ClipSuggestionParams = z.object({ id: z.uuid() });

export const getClips = defineRoute({
  operationId: 'getClips',
  method: 'get',
  path: '/sources/{id}/clips',
  summary: 'Clip suggestions of the newest live-to-clips run of a source',
  tags: ['clips'],
  auth: true,
  request: { params: SourceIdParams },
  responses: {
    200: { description: 'State and clips', schema: ClipsState },
    404: { description: 'No such source', schema: ApiErrorBody },
  },
});

export const generateClips = defineRoute({
  operationId: 'generateClips',
  method: 'post',
  path: '/sources/{id}/clips',
  summary: 'Start (or join) automatic clip generation for a source',
  tags: ['clips'],
  auth: true,
  request: { params: SourceIdParams, body: GenerateClipsBody },
  responses: {
    202: { description: 'Started or joined', schema: ClipsState },
    404: { description: 'No such source', schema: ApiErrorBody },
    409: { description: 'Source not ready or not transcribed (Thai message)', schema: ApiErrorBody },
    429: { description: 'Too many unfinished runs', schema: ApiErrorBody },
  },
});

export const discardClip = defineRoute({
  operationId: 'discardClip',
  method: 'post',
  path: '/clip-suggestions/{id}/discard',
  summary: 'Hide a suggested clip (its project, if any, is kept)',
  tags: ['clips'],
  auth: true,
  request: { params: ClipSuggestionParams },
  responses: {
    200: { description: 'The discarded suggestion', schema: ClipSuggestion },
    404: { description: 'No such suggestion', schema: ApiErrorBody },
  },
});
