import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildOpenApi } from './openapi.js';
import { named } from './registry.js';
import { defineRoute, expressPath } from './route.js';

describe('buildOpenApi', () => {
  it('describes /health with a component ref for both 200 and 503', () => {
    const doc = buildOpenApi() as any;
    expect(doc.openapi).toBe('3.1.0');
    const op = doc.paths['/health'].get;
    expect(op.operationId).toBe('getHealth');
    expect(op.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/HealthReport',
    });
    expect(op.responses['503'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/HealthReport',
    });
    expect(doc.components.schemas.HealthReport.properties.checks.properties.redis).toEqual({
      $ref: '#/components/schemas/CheckStatus',
    });
  });

  it('emits params, query, body and security for a route', () => {
    const Body = named(`TestBody_${Math.random().toString(36).slice(2)}`, z.object({ name: z.string() }));
    const doc = buildOpenApi([
      defineRoute({
        operationId: 'x',
        method: 'post',
        path: '/things/{id}',
        summary: 's',
        tags: ['t'],
        auth: true,
        request: {
          params: z.object({ id: z.uuid() }),
          query: z.object({ q: z.string().optional() }),
          body: Body,
        },
        responses: { 204: { description: 'done' } },
      }),
    ]) as any;
    const op = doc.paths['/things/{id}'].post;
    expect(op.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: expect.objectContaining({ format: 'uuid' }) },
      { name: 'q', in: 'query', required: false, schema: { type: 'string' } },
    ]);
    expect(op.requestBody.content['application/json'].schema.$ref).toMatch(/TestBody_/);
    expect(op.security).toEqual([{ session: [] }]);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(buildOpenApi())).toBe(JSON.stringify(buildOpenApi()));
  });

  it('maps contract paths to express paths', () => {
    expect(expressPath('/a/{id}/b/{bId}')).toBe('/a/:id/b/:bId');
  });
});
