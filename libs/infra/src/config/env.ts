import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v));

/** Every environment variable the backend reads. Names are provider-neutral on purpose (AGENTS.md §11). */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    LOG_PRETTY: bool.default(false),
    DATABASE_URL: z.url(),
    TEST_DATABASE_URL: optionalString,
    REDIS_URL: z.url(),
    SESSION_SECRET: z.string().min(8),
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_DIR: z.string().default('.data/storage'),
    /** Where resumable uploads are assembled before they move into storage. */
    UPLOAD_TMP_DIR: z.string().default('.data/uploads'),
    /** Proxy encoder: libx264 (portable) or h264_videotoolbox (Mac hardware, frees CPU). */
    PROXY_ENCODER: z.enum(['libx264', 'h264_videotoolbox']).default('libx264'),
    /** Long inputs are transcoded in segments of this many seconds (resumable, visible progress). */
    PROXY_SEGMENT_SECONDS: z.coerce.number().int().min(10).default(300),
    S3_ENDPOINT: optionalString,
    S3_REGION: optionalString,
    S3_BUCKET: optionalString,
    S3_ACCESS_KEY_ID: optionalString,
    S3_SECRET_ACCESS_KEY: optionalString,
    AI_SERVICE_URL: z.url().default('http://127.0.0.1:8000'),
    ASR_ENGINE: optionalString,
    LLM_MODE: z.enum(['api', 'local-agent', 'rules']).default('rules'),
    LLM_PROVIDER: optionalString,
    LLM_API_KEY: optionalString,
    LLM_BASE_URL: optionalString,
    LLM_MODEL_FAST: optionalString,
    LLM_MODEL_SMART: optionalString,
    /** Reasoning effort for models that take one (api and local-agent). */
    LLM_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
    LOCAL_AGENT_CLI: z.string().default('claude'),
    LLM_MAX_CALLS_PER_RUN: z.coerce.number().int().min(0).default(50),
    UPLOAD_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(8 * 1024 ** 3),
    /** Redis key prefix for BullMQ (tests use a random one). */
    QUEUE_PREFIX: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .default('myvideo'),
    /** Jobs of one merchant that may be queued or running at once (fairness, ARCHITECTURE §5.7). */
    MERCHANT_MAX_INFLIGHT_JOBS: z.coerce.number().int().min(1).default(2),
    /** Unfinished runs one merchant may have before new requests get 429. */
    MERCHANT_MAX_ACTIVE_RUNS: z.coerce.number().int().min(1).default(20),
    /** How often a running job renews its lease. */
    JOB_HEARTBEAT_MS: z.coerce.number().int().min(50).default(2000),
    /** A running job whose heartbeat is older than this is considered abandoned (worker died). */
    JOB_STALE_AFTER_MS: z.coerce.number().int().min(1000).default(30_000),
    /** A queued job without a queue message for this long goes back to pending. */
    JOB_LOST_AFTER_MS: z.coerce.number().int().min(0).default(30_000),
    /** Dispatcher poll interval; recovery passes run every 20 polls. */
    DISPATCH_POLL_MS: z.coerce.number().int().min(10).default(500),
    QUEUE_MEDIA_CONCURRENCY: z.coerce.number().int().min(1).default(1),
    QUEUE_AI_CONCURRENCY: z.coerce.number().int().min(1).default(1),
    QUEUE_RENDER_CONCURRENCY: z.coerce.number().int().min(1).default(1),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.LLM_MODE === 'local-agent') {
      ctx.addIssue({
        code: 'custom',
        path: ['LLM_MODE'],
        message: 'local-agent mode is for development only and is refused in production (D-009)',
      });
    }
    if (env.LLM_MODE === 'api' && (!env.LLM_PROVIDER || !env.LLM_API_KEY)) {
      ctx.addIssue({
        code: 'custom',
        path: ['LLM_MODE'],
        message: 'LLM_MODE=api needs LLM_PROVIDER and LLM_API_KEY',
      });
    }
    if (
      env.STORAGE_DRIVER === 's3' &&
      (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['STORAGE_DRIVER'],
        message: 'STORAGE_DRIVER=s3 needs S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY',
      });
    }
    if (env.JOB_STALE_AFTER_MS < env.JOB_HEARTBEAT_MS * 3) {
      ctx.addIssue({
        code: 'custom',
        path: ['JOB_STALE_AFTER_MS'],
        message: 'must be at least 3 × JOB_HEARTBEAT_MS, or healthy jobs get reaped as abandoned',
      });
    }
    if (env.NODE_ENV === 'production' && env.SESSION_SECRET === 'change-me') {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_SECRET'],
        message: 'set a real SESSION_SECRET in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export class EnvError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment:\n  ${issues.join('\n  ')}`);
    this.name = 'EnvError';
  }
}

/** Parses the environment. Error messages name the variable, never its value (values can be secrets). */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvError(result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  return result.data;
}
