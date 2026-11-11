import 'reflect-metadata';
import type { Env, HandlerRegistry } from '@myvideo/infra';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './worker.module.js';

/** Builds the worker exactly as production runs it (used by main.ts and integration tests). */
export async function createWorker(env: Env, handlers?: HandlerRegistry): Promise<INestApplicationContext> {
  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(env, handlers), {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  await app.init();
  return app;
}
