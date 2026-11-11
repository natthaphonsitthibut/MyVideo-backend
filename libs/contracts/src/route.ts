import type { z } from 'zod';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export type RouteContract = {
  operationId: string;
  method: HttpMethod;
  /** OpenAPI path syntax, e.g. `/projects/{id}`. */
  path: string;
  summary: string;
  tags: string[];
  /** false = public route (no session cookie required). */
  auth: boolean;
  request?: { params?: z.ZodObject; query?: z.ZodObject; body?: z.ZodType };
  responses: Record<number, { description: string; schema?: z.ZodType }>;
};

export function defineRoute<const R extends RouteContract>(route: R): R {
  return route;
}

/** Nest/Express path syntax for a contract path: `/projects/{id}` → `/projects/:id`. */
export function expressPath(path: string): string {
  return path.replace(/\{(\w+)\}/g, ':$1');
}
