import type { StoragePort } from '@myvideo/domain';
import type { Env } from '../config/env.js';
import { LocalStorage } from './local-storage.js';
import { S3Storage } from './s3-storage.js';

/** Picks the adapter from STORAGE_DRIVER (env validation guarantees the S3 settings exist). */
export function createStorage(env: Env): StoragePort {
  if (env.STORAGE_DRIVER === 's3') {
    return new S3Storage({
      bucket: env.S3_BUCKET ?? '',
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
      secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
    });
  }
  return new LocalStorage(env.STORAGE_LOCAL_DIR);
}
