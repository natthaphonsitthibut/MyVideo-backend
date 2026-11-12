/**
 * Cleanup and retention (E11-F07), pure: decides what may be deleted. Originals are NEVER deleted (AGENTS §8.2);
 * everything else is derived and re-creatable. Rules:
 *  - a storage object no table references (superseded recipe, abandoned keyframes …) after a grace period;
 *  - a render output older than the retention, except the newest render of each project;
 *  - an unfinished upload in the upload temp folder older than the limit.
 */
export type CleanupConfig = { orphanGraceDays: number; renderRetentionDays: number; uploadTmpDays: number };
export const DEFAULT_CLEANUP: CleanupConfig = {
  orphanGraceDays: 1,
  renderRetentionDays: 30,
  uploadTmpDays: 7,
};

export type CleanupItem =
  | { kind: 'storage'; key: string; reason: 'orphan' }
  | { kind: 'storage'; key: string; reason: 'old_render'; renderId: string }
  | { kind: 'upload_tmp'; key: string; reason: 'stale_upload' };

const DAY = 86_400_000;
const ORIGINAL = /^m\/[^/]+\/sources\/[^/]+\/original\.[a-z0-9]+$/;

export function isOriginal(key: string): boolean {
  return ORIGINAL.test(key);
}

export function planCleanup(input: {
  now: Date;
  config: CleanupConfig;
  objects: { key: string; modifiedAt: Date }[];
  referenced: ReadonlySet<string>;
  renders: { id: string; key: string; projectId: string; finishedAt: Date }[];
  uploadTmp: { path: string; modifiedAt: Date }[];
}): CleanupItem[] {
  const now = input.now.getTime();
  const age = (d: Date) => (now - d.getTime()) / DAY;
  const out: CleanupItem[] = [];
  const newest = new Map<string, { id: string; at: number }>();
  for (const r of input.renders) {
    const cur = newest.get(r.projectId);
    if (!cur || r.finishedAt.getTime() > cur.at)
      newest.set(r.projectId, { id: r.id, at: r.finishedAt.getTime() });
  }
  const renderByKey = new Map(input.renders.map((r) => [r.key, r]));
  for (const o of input.objects) {
    if (isOriginal(o.key)) continue;
    const render = renderByKey.get(o.key);
    if (render) {
      if (
        age(render.finishedAt) > input.config.renderRetentionDays &&
        newest.get(render.projectId)?.id !== render.id
      )
        out.push({ kind: 'storage', key: o.key, reason: 'old_render', renderId: render.id });
      continue;
    }
    if (input.referenced.has(o.key)) continue;
    if (age(o.modifiedAt) > input.config.orphanGraceDays)
      out.push({ kind: 'storage', key: o.key, reason: 'orphan' });
  }
  for (const u of input.uploadTmp)
    if (age(u.modifiedAt) > input.config.uploadTmpDays)
      out.push({ kind: 'upload_tmp', key: u.path, reason: 'stale_upload' });
  return out;
}
