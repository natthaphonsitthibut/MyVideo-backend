import { loadEnv } from '@myvideo/infra';
import { createApp } from './app.js';

const env = loadEnv();
const app = await createApp(env);
await app.listen(env.PORT, '127.0.0.1');
