import { loadEnv } from '@myvideo/infra';
import { createWorker } from './app.js';

await createWorker(loadEnv());
