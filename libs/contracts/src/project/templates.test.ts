import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { latestTemplates, TEMPLATE_VERSIONS, TemplateVersion, templateVersion } from './templates.js';

const lock = JSON.parse(readFileSync(new URL('./templates.lock.json', import.meta.url), 'utf8')) as Record<
  string,
  string
>;
const hash = (t: unknown) => createHash('sha256').update(JSON.stringify(t)).digest('hex');

describe('templates', () => {
  it('every published version is valid, unique and unchanged since it was published', () => {
    const keys = TEMPLATE_VERSIONS.map((t) => `${t.id}@${t.version}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const t of TEMPLATE_VERSIONS) {
      expect(TemplateVersion.safeParse(t).success).toBe(true);
      // a changed published version must become a new version (append it and its lock line)
      expect(hash(t), `${t.id}@${t.version} changed — add a new version instead`).toBe(
        lock[`${t.id}@${t.version}`],
      );
      for (const slot of t.slots) expect(slot.minMs).toBeLessThanOrEqual(slot.maxMs);
      expect(t.slots.some((sl) => sl.required)).toBe(true);
    }
    expect(Object.keys(lock).sort()).toEqual([...keys].sort());
  });

  it('the picker offers the newest version of each template; old versions stay readable', () => {
    expect(latestTemplates().map((t) => t.id)).toEqual(['review', 'unboxing', 'showcase']);
    expect(templateVersion('review')?.version).toBe(1);
    expect(templateVersion('review', 1)?.name).toBe('รีวิวสินค้า');
    expect(templateVersion('review', 99)).toBeUndefined();
  });
});
