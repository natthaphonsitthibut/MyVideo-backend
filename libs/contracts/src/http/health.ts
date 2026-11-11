import { z } from 'zod';
import { named } from '../registry.js';
import { defineRoute } from '../route.js';

export const CheckStatus = named(
  'CheckStatus',
  z.object({
    status: z.enum(['up', 'down']),
    latencyMs: z.number().int().nonnegative(),
    error: z.string().optional(),
  }),
);
export type CheckStatus = z.infer<typeof CheckStatus>;

export const HealthReport = named(
  'HealthReport',
  z.object({
    status: z.enum(['ok', 'degraded']),
    checks: z.object({ postgres: CheckStatus, redis: CheckStatus }),
  }),
  'ok when every dependency is up; the HTTP status is 503 otherwise',
);
export type HealthReport = z.infer<typeof HealthReport>;

export const getHealth = defineRoute({
  operationId: 'getHealth',
  method: 'get',
  path: '/health',
  summary: 'Dependency health (Postgres, Redis)',
  tags: ['system'],
  auth: false,
  responses: {
    200: { description: 'All dependencies up', schema: HealthReport },
    503: { description: 'At least one dependency down', schema: HealthReport },
  },
});
