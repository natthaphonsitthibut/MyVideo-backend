import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storageKeys } from '@myvideo/domain';
import { afterAll, describe, expect, it } from 'vitest';
import type { JobEntity } from '../src/db/entities/job.entity.js';
import { FatalJobError } from '../src/jobs/handlers.js';
import { purgeHandler, renderPrefix, sourcePrefix } from '../src/maintenance/purge.js';
import { LocalStorage } from '../src/storage/local-storage.js';

const M = '01a1d000-0000-7000-8000-000000000001';
const OTHER = '01a1d000-0000-7000-8000-000000000002';
const SRC = '01a1d000-0000-7000-8000-0000000000a1';
const KEEP = '01a1d000-0000-7000-8000-0000000000a2';
const REN = '01a1d000-0000-7000-8000-0000000000b1';

describe('storage.purge (local storage on disk)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'myvideo-purge-'));
  const storage = new LocalStorage(dir);
  const handler = purgeHandler(storage);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const run = (merchantId: string, prefixes: unknown) =>
    handler.run({
      job: { merchantId, payload: { prefixes } } as unknown as JobEntity,
      attempt: 1,
      signal: new AbortController().signal,
      progress: async () => undefined,
    });

  it('deletes every file under the prefixes and is idempotent', async () => {
    const files = [
      storageKeys.original(M, SRC, 'mp4'),
      storageKeys.derived(M, SRC, SRC, 'proxy', 1, 'mp4'),
      storageKeys.spriteSheet(M, SRC, SRC, 1, 0),
      storageKeys.render(M, REN, 'out.mp4'),
    ];
    const kept = storageKeys.original(M, KEEP, 'mp4');
    for (const k of [...files, kept]) await storage.put(k, Buffer.from(k));

    expect(await run(M, [sourcePrefix(M, SRC), renderPrefix(M, REN)])).toEqual({ deleted: 4 });
    for (const k of files) expect(await storage.stat(k)).toBeNull();
    expect(await storage.stat(kept)).not.toBeNull(); // another source of the same merchant stays
    expect(await run(M, [sourcePrefix(M, SRC)])).toEqual({ deleted: 0 }); // retry after success
  });

  it("refuses another merchant's prefix or any other shape (dead job, nothing deleted)", async () => {
    const theirs = storageKeys.original(OTHER, SRC, 'mp4');
    await storage.put(theirs, Buffer.from('x'));
    await expect(run(M, [sourcePrefix(OTHER, SRC)])).rejects.toBeInstanceOf(FatalJobError);
    await expect(run(M, [`m/${M}/`])).rejects.toBeInstanceOf(FatalJobError);
    await expect(run(M, [`m/${M}/sources/../`])).rejects.toBeInstanceOf(FatalJobError);
    await expect(run(M, [])).rejects.toBeInstanceOf(FatalJobError);
    expect(await storage.stat(theirs)).not.toBeNull();
  });
});
