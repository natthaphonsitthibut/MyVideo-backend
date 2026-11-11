import type { Env } from '@myvideo/infra';
import { Module } from '@nestjs/common';
import { ENV } from '../config/env.module.js';
import { SourcesController } from './sources.controller.js';
import { SourcesService, TUS_STORE } from './sources.service.js';
import { createTusStore } from './tus.js';

@Module({
  controllers: [SourcesController],
  providers: [
    SourcesService,
    { provide: TUS_STORE, inject: [ENV], useFactory: (env: Env) => createTusStore(env) },
  ],
  exports: [SourcesService, TUS_STORE],
})
export class SourcesModule {}
