import { z } from 'zod';
import { componentRegistry } from './registry.js';
import type { RouteContract } from './route.js';
import { routes } from './routes.js';

type JsonObject = Record<string, unknown>;
const REF = (id: string) => `#/components/schemas/${id}`;

/** Bodies and responses must be named components (good generated type names, no inline duplicates). */
function refFor(schema: z.ZodType, where: string): JsonObject {
  const id = componentRegistry.get(schema)?.id;
  if (!id) throw new Error(`${where}: schema must be registered with named()`);
  return { $ref: REF(id) };
}

/** Path/query parameters are plain scalars, converted inline. */
function scalarSchema(schema: z.ZodType): JsonObject {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'throw' }) as JsonObject;
  delete json.$schema;
  return json;
}

function parameters(route: RouteContract): JsonObject[] {
  const out: JsonObject[] = [];
  for (const where of ['path', 'query'] as const) {
    const obj = where === 'path' ? route.request?.params : route.request?.query;
    if (!obj) continue;
    for (const [name, field] of Object.entries(obj.shape)) {
      out.push({
        name,
        in: where,
        required: where === 'path' || !(field as z.ZodType).safeParse(undefined).success,
        schema: scalarSchema(field as z.ZodType),
      });
    }
  }
  return out;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys((value as JsonObject)[k])]),
    );
  }
  return value;
}

/** Builds the OpenAPI 3.1 document from the route contracts. Output is key-sorted so diffs are stable. */
export function buildOpenApi(list: RouteContract[] = routes): JsonObject {
  const paths: Record<string, JsonObject> = {};
  const seen = new Set<string>();
  for (const route of list) {
    if (seen.has(route.operationId)) throw new Error(`duplicate operationId ${route.operationId}`);
    seen.add(route.operationId);
    const op: JsonObject = {
      operationId: route.operationId,
      summary: route.summary,
      tags: route.tags,
      responses: Object.fromEntries(
        Object.entries(route.responses).map(([status, r]) => [
          status,
          r.schema
            ? {
                description: r.description,
                content: {
                  'application/json': { schema: refFor(r.schema, `${route.operationId} ${status}`) },
                },
              }
            : { description: r.description },
        ]),
      ),
    };
    const params = parameters(route);
    if (params.length) op.parameters = params;
    if (route.request?.body) {
      op.requestBody = {
        required: true,
        content: { 'application/json': { schema: refFor(route.request.body, `${route.operationId} body`) } },
      };
    }
    if (route.auth) op.security = [{ session: [] }];
    paths[route.path] = { ...paths[route.path], [route.method]: op };
  }
  const { schemas } = z.toJSONSchema(componentRegistry, { uri: REF, io: 'output', unrepresentable: 'throw' });
  for (const s of Object.values(schemas)) {
    delete (s as JsonObject).$schema;
    delete (s as JsonObject).$id;
  }
  return sortKeys({
    openapi: '3.1.0',
    info: { title: 'MyVideo API', version: '0.1.0' },
    paths,
    components: {
      schemas,
      securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'myvideo_session' } },
    },
  }) as JsonObject;
}
