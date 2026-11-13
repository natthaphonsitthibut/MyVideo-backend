import { z } from 'zod';
import { named } from '../registry.js';
import { defineRoute } from '../route.js';
export const MusicRecord = named(
  'MusicRecord',
  z.object({
    id: z.uuid(),
    title: z.string(),
    license: z.string(),
    status: z.enum(['processing', 'ready', 'failed']),
    durationMs: z.number().int().nullable(),
    error: z.string().nullable(),
    analysis: z
      .object({
        bpm: z.number().nullable(),
        confidence: z.number(),
        firstBeatSec: z.number().nullable(),
        beatsSec: z.array(z.number()),
        dropsSec: z.array(z.number()),
      })
      .nullable(),
  }),
);
export const MusicUploadQuery = z.object({
  title: z.string().trim().min(1).max(200),
  license: z.string().trim().min(1).max(300),
});
export const MusicParams = z.object({ id: z.uuid() });
export const musicRoutes = [
  defineRoute({
    operationId: 'listMusic',
    method: 'get',
    path: '/music',
    summary: 'Merchant-owned music library and measured beat estimates',
    tags: ['music'],
    auth: true,
    responses: {
      200: { description: 'Music', schema: named('MusicList', z.object({ items: z.array(MusicRecord) })) },
    },
  }),
  defineRoute({
    operationId: 'uploadMusic',
    method: 'post',
    path: '/music',
    summary: 'Upload raw audio, max 30 MB, with merchant-supplied rights information',
    tags: ['music'],
    auth: true,
    request: { query: MusicUploadQuery },
    responses: { 202: { description: 'Background analysis queued', schema: MusicRecord } },
  }),
  defineRoute({
    operationId: 'getMusicFile',
    method: 'get',
    path: '/music/{id}/file',
    summary: 'Stream an owned music file',
    tags: ['music'],
    auth: true,
    request: { params: MusicParams },
    responses: {
      200: { description: 'Audio' },
      206: { description: 'Audio range' },
      404: { description: 'Not found' },
    },
  }),
];
