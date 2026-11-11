import { z } from 'zod';

/** Named schemas become `#/components/schemas/<id>` in openapi.json and named types in the frontend. */
export const componentRegistry = z.registry<{ id: string; description?: string }>();

export function named<T extends z.ZodType>(id: string, schema: T, description?: string): T {
  componentRegistry.add(schema, description ? { id, description } : { id });
  return schema;
}
