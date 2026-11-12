import { describe, expect, it } from 'vitest';
import { migrateProject } from './migrate.js';
import { PROJECT_SCHEMA_VERSION } from './schema.js';

describe('migrateProject', () => {
  it('returns a current-version document unchanged', () => {
    const doc = { schemaVersion: PROJECT_SCHEMA_VERSION, id: 'x' };
    expect(migrateProject(doc)).toEqual({ ok: true, doc, from: PROJECT_SCHEMA_VERSION, applied: [] });
  });

  it('applies each step in order up to the current version', () => {
    const steps = {
      // hypothetical history: v-1 → v0 → v1
      [PROJECT_SCHEMA_VERSION - 2]: (d: Record<string, unknown>) => ({ ...d, a: true }),
      [PROJECT_SCHEMA_VERSION - 1]: (d: Record<string, unknown>) => ({ ...d, b: d.a === true }),
    };
    const r = migrateProject({ schemaVersion: PROJECT_SCHEMA_VERSION - 2 }, steps);
    expect(r).toEqual({
      ok: true,
      doc: { schemaVersion: PROJECT_SCHEMA_VERSION, a: true, b: true },
      from: PROJECT_SCHEMA_VERSION - 2,
      applied: [PROJECT_SCHEMA_VERSION - 2, PROJECT_SCHEMA_VERSION - 1],
    });
  });

  it('refuses a newer document, a missing step and a missing version', () => {
    expect(migrateProject({ schemaVersion: PROJECT_SCHEMA_VERSION + 1 })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/newer than this app/),
    });
    expect(migrateProject({ schemaVersion: PROJECT_SCHEMA_VERSION - 1 }, {})).toMatchObject({
      ok: false,
      message: expect.stringMatching(new RegExp(`no migration from v${PROJECT_SCHEMA_VERSION - 1}`)),
    });
    expect(migrateProject({ id: 'x' })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/schemaVersion/),
    });
    expect(migrateProject('nope')).toMatchObject({ ok: false });
  });
});
