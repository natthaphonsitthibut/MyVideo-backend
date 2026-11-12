import { describe, it } from 'vitest';
import { S3Storage } from '../src/storage/s3-storage.js';
import { storageContract } from '../src/storage/storage-contract.js';

// Runs the shared contract against a real S3-compatible bucket when credentials are configured (E03-F01 spec).
// No bucket is available on the dev machine or in CI today; this is recorded in PROGRESS as not run.
const cfg = {
  bucket: process.env.S3_TEST_BUCKET,
  accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY,
};
if (cfg.bucket && cfg.accessKeyId && cfg.secretAccessKey) {
  storageContract(
    's3',
    () =>
      new S3Storage({
        bucket: cfg.bucket ?? '',
        accessKeyId: cfg.accessKeyId ?? '',
        secretAccessKey: cfg.secretAccessKey ?? '',
        region: process.env.S3_TEST_REGION,
        endpoint: process.env.S3_TEST_ENDPOINT,
      }),
  );
} else {
  describe('StoragePort contract: s3', () => {
    it.skip('needs S3_TEST_BUCKET / S3_TEST_ACCESS_KEY_ID / S3_TEST_SECRET_ACCESS_KEY', () => {});
  });
}
