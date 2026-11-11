import { createDataSource, type Env } from '@myvideo/infra';
import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ENV } from '../config/env.module.js';

@Injectable()
class DataSourceCloser implements OnApplicationShutdown {
  constructor(@Inject(DataSource) private readonly ds: DataSource) {}
  async onApplicationShutdown(): Promise<void> {
    if (this.ds.isInitialized) await this.ds.destroy();
  }
}

/** One TypeORM DataSource (pool) per process. Schema changes only via migrations. */
@Global()
@Module({
  providers: [
    {
      provide: DataSource,
      inject: [ENV],
      useFactory: (env: Env) => createDataSource(env.DATABASE_URL).initialize(),
    },
    DataSourceCloser,
  ],
  exports: [DataSource],
})
export class DatabaseModule {}
