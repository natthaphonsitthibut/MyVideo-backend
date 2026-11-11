import { DataSource } from 'typeorm';
import { entities } from './entities/index.js';
import { migrations } from './migrations/index.js';

/** The only way the app builds a DataSource. `synchronize` is always off: schema changes go through migrations. */
export function createDataSource(url: string, opts: { logging?: boolean } = {}): DataSource {
  return new DataSource({
    type: 'postgres',
    url,
    entities,
    migrations,
    migrationsTableName: 'typeorm_migrations',
    migrationsTransactionMode: 'each',
    synchronize: false,
    logging: opts.logging ?? false,
    extra: { max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 },
  });
}
