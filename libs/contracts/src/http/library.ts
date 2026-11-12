import { z } from 'zod';
import { defineRoute } from '../route.js';
import { ApiErrorBody } from './errors.js';

export const LibrarySoundParams = z.object({ id: z.string().regex(/^[a-z0-9-]{1,64}$/) });

export const getLibrarySound = defineRoute({
  operationId: 'getLibrarySound',
  method: 'get',
  path: '/library/sounds/{id}',
  summary:
    'Stream a product library sound (WAV, supports HTTP Range). Same for every merchant; never merchant data (D-026).',
  tags: ['library'],
  auth: true,
  request: { params: LibrarySoundParams },
  responses: {
    200: { description: 'Whole file' },
    206: { description: 'Requested byte range' },
    404: { description: 'No such library sound, or its file is not installed', schema: ApiErrorBody },
    416: { description: 'Range not satisfiable', schema: ApiErrorBody },
  },
});
