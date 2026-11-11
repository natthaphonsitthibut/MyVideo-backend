// Entry point for the TypeORM CLI (`pnpm migration:generate`). Reads DATABASE_URL only.
import { createDataSource } from './data-source.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
export default createDataSource(url);
