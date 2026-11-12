import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadEnv } from '../config/env.js';
import { createDataSource } from '../db/data-source.js';
import { runCleanup } from '../maintenance/cleanup.js';
import { createStorage } from '../storage/create-storage.js';

/**
 * `pnpm cleanup` = dry run (lists what would go); `pnpm cleanup --apply` deletes. Run daily from cron/systemd on a
 * server (no scheduler inside the app — ARCHITECTURE §8.9 keeps infra minimal).
 */
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { apply: { type: 'boolean', default: false } } });
  const env = loadEnv();
  const ds = createDataSource(env.DATABASE_URL);
  await ds.initialize();
  try {
    const r = await runCleanup(ds, createStorage(env), {
      apply: Boolean(values.apply),
      uploadTmpDir: env.UPLOAD_TMP_DIR,
    });
    for (const i of r.items)
      console.log(`${values.apply ? 'deleted' : 'would delete'}  ${i.reason.padEnd(12)} ${i.key}`);
    console.log(
      values.apply
        ? `deleted ${r.deleted} item(s), ${(r.bytes / 1e6).toFixed(1)} MB`
        : `dry run: ${r.items.length} item(s); run with --apply to delete`,
    );
  } finally {
    await ds.destroy();
  }
}
