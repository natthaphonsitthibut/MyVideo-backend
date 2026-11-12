import { PROJECT_SCHEMA_VERSION } from './schema.js';

type Doc = Record<string, unknown>;
/** Step from version N to N+1 (keyed by N). Pure; must not drop user content. */
export type ProjectMigration = (doc: Doc) => Doc;

/** Every migration step, keyed by the version it upgrades FROM. Empty while v1 is the only version. */
export const PROJECT_MIGRATIONS: Readonly<Record<number, ProjectMigration>> = {};

export type MigrationResult =
  | { ok: true; doc: Doc; from: number; applied: number[] }
  | { ok: false; message: string };

/**
 * Brings a stored Project JSON up to `PROJECT_SCHEMA_VERSION` one step at a time (ARCHITECTURE §6). Run before
 * `validateProject` when reading old versions; stored versions are never rewritten in place.
 */
export function migrateProject(
  input: unknown,
  migrations: Readonly<Record<number, ProjectMigration>> = PROJECT_MIGRATIONS,
): MigrationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return { ok: false, message: 'project must be a JSON object' };
  const from = (input as Doc).schemaVersion;
  if (typeof from !== 'number' || !Number.isInteger(from))
    return { ok: false, message: 'project has no integer schemaVersion' };
  if (from > PROJECT_SCHEMA_VERSION)
    return {
      ok: false,
      message: `project schemaVersion ${from} is newer than this app (v${PROJECT_SCHEMA_VERSION})`,
    };
  let doc: Doc = input as Doc;
  const applied: number[] = [];
  for (let v = from; v < PROJECT_SCHEMA_VERSION; v++) {
    const step = migrations[v];
    if (!step) return { ok: false, message: `no migration from v${v} to v${v + 1}` };
    doc = { ...step(doc), schemaVersion: v + 1 };
    applied.push(v);
  }
  return { ok: true, doc, from, applied };
}
