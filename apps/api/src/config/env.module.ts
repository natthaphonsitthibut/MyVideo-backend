import { type Env, loadEnv } from '@myvideo/infra';
import { type DynamicModule, Global, Module } from '@nestjs/common';

export const ENV = Symbol('ENV');

@Global()
@Module({})
export class EnvModule {
  /** `env` lets tests inject a parsed config; otherwise `process.env` is parsed (fails fast on bad values). */
  static forRoot(env?: Env): DynamicModule {
    return {
      module: EnvModule,
      providers: [{ provide: ENV, useValue: env ?? loadEnv() }],
      exports: [ENV],
    };
  }
}
