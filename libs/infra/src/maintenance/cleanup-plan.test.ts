import { describe, expect, it } from 'vitest';
import { planCleanup } from './cleanup-plan.js';

const DAY = 86_400_000;
const now = new Date('2026-11-12T12:00:00Z');
const ago = (days: number) => new Date(now.getTime() - days * DAY);
const M = 'm/00000000-0000-4000-8000-0000000000aa';
const config = { orphanGraceDays: 1, renderRetentionDays: 30, uploadTmpDays: 7 };

describe('cleanup plan', () => {
  it('never touches originals, keeps referenced files, removes old orphans only', () => {
    const plan = planCleanup({
      now,
      config,
      objects: [
        { key: `${M}/sources/s1/original.mp4`, modifiedAt: ago(400) },
        { key: `${M}/sources/s1/derived/a1/proxy-v2.mp4`, modifiedAt: ago(90) },
        { key: `${M}/sources/s1/derived/a1/proxy-v1.mp4`, modifiedAt: ago(90) }, // superseded recipe
        { key: `${M}/sources/s1/derived/a1/peaks-v1.json`, modifiedAt: ago(0.2) }, // orphan, but fresh
      ],
      referenced: new Set([`${M}/sources/s1/derived/a1/proxy-v2.mp4`]),
      renders: [],
      uploadTmp: [],
    });
    expect(plan).toEqual([
      { key: `${M}/sources/s1/derived/a1/proxy-v1.mp4`, reason: 'orphan', kind: 'storage' },
    ]);
  });

  it('old renders go, except the newest render of each project; recent ones stay', () => {
    const plan = planCleanup({
      now,
      config,
      objects: [
        { key: `${M}/renders/r-old.mp4`, modifiedAt: ago(60) },
        { key: `${M}/renders/r-newest.mp4`, modifiedAt: ago(45) },
        { key: `${M}/renders/r-recent.mp4`, modifiedAt: ago(3) },
      ],
      referenced: new Set([
        `${M}/renders/r-old.mp4`,
        `${M}/renders/r-newest.mp4`,
        `${M}/renders/r-recent.mp4`,
      ]),
      renders: [
        { id: 'r1', key: `${M}/renders/r-old.mp4`, projectId: 'p1', finishedAt: ago(60) },
        { id: 'r2', key: `${M}/renders/r-newest.mp4`, projectId: 'p1', finishedAt: ago(45) },
        { id: 'r3', key: `${M}/renders/r-recent.mp4`, projectId: 'p2', finishedAt: ago(3) },
      ],
      uploadTmp: [],
    });
    expect(plan).toEqual([
      { key: `${M}/renders/r-old.mp4`, reason: 'old_render', kind: 'storage', renderId: 'r1' },
    ]);
  });

  it('unfinished uploads older than the limit are removed from the upload folder', () => {
    const plan = planCleanup({
      now,
      config,
      objects: [],
      referenced: new Set(),
      renders: [],
      uploadTmp: [
        { path: '/tmp/up/abc', modifiedAt: ago(10) },
        { path: '/tmp/up/def', modifiedAt: ago(1) },
      ],
    });
    expect(plan).toEqual([{ key: '/tmp/up/abc', reason: 'stale_upload', kind: 'upload_tmp' }]);
  });
});
