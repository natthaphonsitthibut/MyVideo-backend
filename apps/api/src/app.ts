import 'reflect-metadata';
import type { Env } from '@myvideo/infra';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { SessionService } from './auth/session.service.js';
import { ApiErrorFilter } from './common/error.filter.js';
import { originCheck } from './common/origin-check.js';
import { ENV } from './config/env.module.js';
import { SourcesService, TUS_STORE } from './sources/sources.service.js';
import { createTusMiddleware } from './sources/tus.js';

/** Builds the HTTP app exactly as production runs it (used by main.ts and by integration tests). */
export async function createApp(env: Env): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(env), { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.use(originCheck);
  app.useGlobalFilters(new ApiErrorFilter());
  // tus speaks its own protocol (HEAD/PATCH/OPTIONS, offset bodies), so it is mounted as middleware
  app.use(
    createTusMiddleware(app.get(ENV), app.get(TUS_STORE), app.get(SessionService), app.get(SourcesService)),
  );
  app.enableShutdownHooks();
  return app;
}
