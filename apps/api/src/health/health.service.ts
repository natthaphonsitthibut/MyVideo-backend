import { type Env, type ProbeResult, probePostgres, probeRedis } from '@myvideo/infra';
import { Inject, Injectable } from '@nestjs/common';
import { ENV } from '../config/env.module.js';

export type HealthReport = {
  status: 'ok' | 'degraded';
  checks: Record<'postgres' | 'redis', ProbeResult>;
};

@Injectable()
export class HealthService {
  constructor(@Inject(ENV) private readonly env: Env) {}

  async check(): Promise<HealthReport> {
    const [postgres, redis] = await Promise.all([
      probePostgres(this.env.DATABASE_URL),
      probeRedis(this.env.REDIS_URL),
    ]);
    const checks = { postgres, redis };
    const ok = Object.values(checks).every((c) => c.status === 'up');
    return { status: ok ? 'ok' : 'degraded', checks };
  }
}
