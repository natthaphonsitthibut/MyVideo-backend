import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { StoragePort } from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import {
  type CleanupConfig,
  type CleanupItem,
  DEFAULT_CLEANUP,
  isOriginal,
  planCleanup,
} from './cleanup-plan.js';

/**
 * Runs the cleanup plan (E11-F07). Dry run by default: returns what WOULD be removed and deletes nothing. An old
 * render's row goes first (so nobody is offered a missing file), then its file. Originals are checked once more
 * right before each delete.
 */
export async function runCleanup(
  ds: DataSource,
  storage: StoragePort,
  o: { apply: boolean; uploadTmpDir?: string; config?: CleanupConfig; now?: Date },
): Promise<{ items: CleanupItem[]; deleted: number; bytes: number }> {
  const now = o.now ?? new Date();
  const keys = await storage.list('m/');
  const objects: { key: string; modifiedAt: Date; size: number }[] = [];
  for (const key of keys) {
    const s = await storage.stat(key);
    if (s) objects.push({ key, modifiedAt: s.modifiedAt, size: s.size });
  }
  const refRows: { key: string }[] = await ds.query(`
    SELECT storage_key AS key FROM media_assets
    UNION SELECT storage_key FROM transcripts WHERE storage_key IS NOT NULL
    UNION SELECT logo_key FROM brand_kits WHERE logo_key IS NOT NULL
    UNION SELECT kf->>'storageKey' FROM detected_shots, jsonb_array_elements(keyframes) kf
    UNION SELECT kf->>'storageKey' FROM analyses, jsonb_array_elements(parts) p,
           jsonb_array_elements(COALESCE(p->'shots', '[]'::jsonb)) s, jsonb_array_elements(s->'keyframes') kf`);
  const renders: { id: string; key: string; project_id: string; finished_at: Date }[] = await ds.query(
    `SELECT id, output_key AS key, project_id, finished_at FROM renders WHERE output_key IS NOT NULL AND finished_at IS NOT NULL`,
  );
  const uploadTmp: { path: string; modifiedAt: Date }[] = [];
  if (o.uploadTmpDir) {
    for (const name of await readdir(o.uploadTmpDir).catch(() => [] as string[])) {
      const path = join(o.uploadTmpDir, name);
      const s = await stat(path).catch(() => null);
      if (s?.isFile()) uploadTmp.push({ path, modifiedAt: s.mtime });
    }
  }
  const items = planCleanup({
    now,
    config: o.config ?? DEFAULT_CLEANUP,
    objects,
    referenced: new Set(refRows.map((r) => r.key)),
    renders: renders.map((r) => ({
      id: r.id,
      key: r.key,
      projectId: r.project_id,
      finishedAt: new Date(r.finished_at),
    })),
    uploadTmp,
  });
  const sizes = new Map(objects.map((x) => [x.key, x.size]));
  let deleted = 0;
  let bytes = 0;
  if (o.apply) {
    for (const item of items) {
      if (item.kind === 'upload_tmp') {
        await rm(item.key, { force: true });
      } else {
        if (isOriginal(item.key)) continue; // belt and braces: never an original
        if (item.reason === 'old_render')
          await ds.query(`DELETE FROM renders WHERE id = $1`, [item.renderId]);
        await storage.delete(item.key);
        bytes += sizes.get(item.key) ?? 0;
      }
      deleted++;
    }
  }
  return { items, deleted, bytes };
}
