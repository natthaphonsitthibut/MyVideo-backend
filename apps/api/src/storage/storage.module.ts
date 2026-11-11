import { createStorage, type Env } from '@myvideo/infra';
import { Global, Module } from '@nestjs/common';
import { ENV } from '../config/env.module.js';

export const STORAGE = Symbol('STORAGE');

@Global()
@Module({
  providers: [{ provide: STORAGE, inject: [ENV], useFactory: (env: Env) => createStorage(env) }],
  exports: [STORAGE],
})
export class StorageModule {}
