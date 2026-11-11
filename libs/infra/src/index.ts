export {
  AiHealth,
  AiServiceClient,
  type AiServiceClientOptions,
  AiServiceError,
  AiServiceUnavailableError,
} from './ai/ai-service.client.js';
export { hashPassword, verifyPassword } from './auth/password.js';
export { type Env, EnvError, envSchema, loadEnv } from './config/env.js';
export { createDataSource } from './db/data-source.js';
export { entities, MerchantEntity, SessionEntity, UserEntity } from './db/entities/index.js';
export { migrations } from './db/migrations/index.js';
export { type SeedInput, seedMerchant } from './db/seed.js';
export { TenantRepository, type TenantRow } from './db/tenant/tenant-repository.js';
export { type ProbeResult, probePostgres, probeRedis } from './health/probes.js';
