import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Env } from '@myvideo/infra';
import { type DynamicModule, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module.js';
import { EnvModule } from './config/env.module.js';
import { DatabaseModule } from './db/database.module.js';
import { HealthModule } from './health/health.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { RunsModule } from './runs/runs.module.js';
import { SourcesModule } from './sources/sources.module.js';
import { StorageModule } from './storage/storage.module.js';
import { TranscriptsModule } from './transcripts/transcripts.module.js';

const REQUEST_ID_HEADER = 'x-request-id';
const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Reuses a well-formed incoming `x-request-id`, otherwise creates one; echoes it on the response. */
export function requestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const id = typeof incoming === 'string' && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}

@Module({})
export class AppModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [
        EnvModule.forRoot(env),
        // Lets tests and startup checks list controller routes (contract drift test).
        DiscoveryModule,
        LoggerModule.forRoot({
          pinoHttp: {
            level: env.LOG_LEVEL,
            genReqId: requestId,
            customProps: (req) => ({ requestId: req.id }),
            redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
            ...(env.LOG_PRETTY ? { transport: { target: 'pino-pretty' } } : {}),
          },
        }),
        DatabaseModule,
        AuthModule,
        HealthModule,
        JobsModule,
        RunsModule,
        StorageModule,
        SourcesModule,
        TranscriptsModule,
      ],
    };
  }
}
