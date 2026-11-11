import type { HealthReport } from '@myvideo/contracts';
import { AiServiceClient, type Env, probePostgres, probeRedis } from '@myvideo/infra';
import { Inject, Injectable } from '@nestjs/common';
import { ENV } from '../config/env.module.js';

@Injectable()
export class HealthService {
  constructor(@Inject(ENV) private readonly env: Env) {}

  async check(): Promise<HealthReport> {
    const [postgres, redis, ai] = await Promise.all([
      probePostgres(this.env.DATABASE_URL),
      probeRedis(this.env.REDIS_URL),
      new AiServiceClient({ baseUrl: this.env.AI_SERVICE_URL }).probe(),
    ]);
    const checks = { postgres, redis, ai };
    const ok = Object.values(checks).every((c) => c.status === 'up');
    return { status: ok ? 'ok' : 'degraded', checks };
  }
}
