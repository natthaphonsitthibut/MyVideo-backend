import type { StructuredSchema } from '@myvideo/domain';
import { z } from 'zod';

/** Keyword constraints that hosted structured-output modes do not accept; Zod still enforces them after the call. */
const DROPPED = new Set([
  '$schema',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'pattern',
  'format',
]);

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (!DROPPED.has(k)) out[k] = strip(v);
  }
  return out;
}

/** A StructuredSchema from a Zod schema: JSON schema for the model (portable subset), Zod for the answer. */
export function zodStructuredSchema<T>(name: string, schema: z.ZodType<T>): StructuredSchema<T> {
  return {
    name,
    jsonSchema: strip(z.toJSONSchema(schema)) as Record<string, unknown>,
    parse: (value) => {
      const r = schema.safeParse(value);
      if (r.success) return { ok: true, value: r.data };
      return {
        ok: false,
        error: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
      };
    },
  };
}
