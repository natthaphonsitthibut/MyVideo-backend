import 'reflect-metadata';
import { loadEnv } from '@myvideo/infra';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './worker.module.js';

const env = loadEnv();
const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(env), { bufferLogs: true });
app.useLogger(app.get(Logger));
app.enableShutdownHooks();
await app.init();
