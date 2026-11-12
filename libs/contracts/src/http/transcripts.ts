import { z } from 'zod';
import { named } from '../registry.js';
import { defineRoute } from '../route.js';
import { ApiErrorBody } from './errors.js';
import { SourceIdParams } from './sources.js';

export const TranscriptWord = named(
  'TranscriptWord',
  z.object({
    text: z.string(),
    /** Milliseconds on the source timeline. */
    startMs: z.number().int(),
    endMs: z.number().int(),
    /** `word` | `number` | `latin` | `punct` … (from the Thai tokenizer). */
    kind: z.string(),
    /** The ASR text when the merchant corrected this word (then `text` is the correction); null = not edited. */
    original: z.string().nullable(),
  }),
);

export const TranscriptSegment = named(
  'TranscriptSegment',
  z.object({
    /** 0-based position in the transcript (also the pagination cursor). */
    seq: z.number().int(),
    startMs: z.number().int(),
    endMs: z.number().int(),
    /** ASR text, or the words joined when any word was corrected. */
    text: z.string(),
    words: z.array(TranscriptWord),
  }),
);
export type TranscriptSegment = z.infer<typeof TranscriptSegment>;

export const TranscriptWordParams = z.object({
  id: z.uuid(),
  seq: z.coerce.number().int().min(0),
  index: z.coerce.number().int().min(0),
});

export const TranscriptWordEdit = named(
  'TranscriptWordEdit',
  z.object({
    /** The corrected text (timing stays the word's ASR timing). */
    text: z
      .string()
      .transform((s) => s.normalize('NFC').trim())
      .pipe(z.string().min(1).max(200)),
  }),
);

export const editTranscriptWord = defineRoute({
  operationId: 'editTranscriptWord',
  method: 'put',
  path: '/sources/{id}/transcript/words/{seq}/{index}',
  summary: 'Correct one word of the ready transcript (stored as a user layer; the ASR original is kept)',
  tags: ['transcripts'],
  auth: true,
  request: { params: TranscriptWordParams, body: TranscriptWordEdit },
  responses: {
    200: { description: 'The segment with the correction applied', schema: TranscriptSegment },
    400: { description: 'Invalid text', schema: ApiErrorBody },
    404: { description: 'No such source, ready transcript, segment or word', schema: ApiErrorBody },
  },
});

export const revertTranscriptWord = defineRoute({
  operationId: 'revertTranscriptWord',
  method: 'delete',
  path: '/sources/{id}/transcript/words/{seq}/{index}',
  summary: 'Remove the correction of one word (back to the ASR text)',
  tags: ['transcripts'],
  auth: true,
  request: { params: TranscriptWordParams },
  responses: {
    200: { description: 'The segment as recognised', schema: TranscriptSegment },
    404: { description: 'No such source, ready transcript, segment or word', schema: ApiErrorBody },
  },
});

export const TranscriptState = named(
  'TranscriptState',
  z.object({
    /** `none` = never transcribed; otherwise the newest transcript of the source's current audio. */
    status: z.enum(['none', 'running', 'ready', 'failed']),
    transcriptId: z.uuid().nullable(),
    /** Newest transcribe run (live progress via /workflow-runs/{id}/events). */
    runId: z.uuid().nullable(),
    chunkCount: z.number().int(),
    chunksDone: z.number().int(),
    segmentCount: z.number().int(),
    durationMs: z.number().int().nullable(),
    language: z.string().nullable(),
    model: z.string().nullable(),
    /** Merchant-readable reason (Thai) when failed. */
    error: z.string().nullable(),
  }),
);
export type TranscriptState = z.infer<typeof TranscriptState>;

export const getTranscript = defineRoute({
  operationId: 'getTranscript',
  method: 'get',
  path: '/sources/{id}/transcript',
  summary: 'Transcript state of a source (status, chunk progress, counts)',
  tags: ['transcripts'],
  auth: true,
  request: { params: SourceIdParams },
  responses: {
    200: { description: 'Transcript state', schema: TranscriptState },
    404: { description: 'No such source for this merchant', schema: ApiErrorBody },
  },
});

export const startTranscript = defineRoute({
  operationId: 'startTranscript',
  method: 'post',
  path: '/sources/{id}/transcript',
  summary:
    'Transcribe the source (idempotent: joins an unfinished run; a finished transcript of the same audio is reused)',
  tags: ['transcripts'],
  auth: true,
  request: { params: SourceIdParams },
  responses: {
    202: { description: 'Transcription started or joined', schema: TranscriptState },
    404: { description: 'No such source for this merchant', schema: ApiErrorBody },
    409: { description: 'Source not ready yet, or it has no audio', schema: ApiErrorBody },
    429: { description: 'Too many unfinished runs for this merchant (back-pressure)', schema: ApiErrorBody },
  },
});

export const TranscriptSegmentsQuery = z.object({
  /** Return segments with seq ≥ this (cursor from the previous page). */
  from: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

export const TranscriptSegmentPage = named(
  'TranscriptSegmentPage',
  z.object({
    transcriptId: z.uuid(),
    items: z.array(TranscriptSegment),
    /** `from` for the next page; null on the last page. */
    nextFrom: z.number().int().nullable(),
    total: z.number().int(),
  }),
);
export type TranscriptSegmentPage = z.infer<typeof TranscriptSegmentPage>;

export const listTranscriptSegments = defineRoute({
  operationId: 'listTranscriptSegments',
  method: 'get',
  path: '/sources/{id}/transcript/segments',
  summary: 'Segments of the ready transcript, in order, paginated by seq',
  tags: ['transcripts'],
  auth: true,
  request: { params: SourceIdParams, query: TranscriptSegmentsQuery },
  responses: {
    200: { description: 'A page of segments', schema: TranscriptSegmentPage },
    404: { description: 'No such source, or no ready transcript', schema: ApiErrorBody },
  },
});
