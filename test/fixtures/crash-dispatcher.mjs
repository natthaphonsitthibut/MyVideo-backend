// Crash fixture: claims due jobs (commits them as queued) and dies with SIGKILL before publishing to BullMQ.
// Uses the built libs (run `pnpm build` first). Args: none; env: DATABASE_URL, REDIS_URL, QUEUE_PREFIX.
import { createDataSource, Dispatcher, QueueSet } from '../../libs/infra/dist/index.js';

const ds = await createDataSource(process.env.DATABASE_URL).initialize();
const qs = new QueueSet({ redisUrl: process.env.REDIS_URL, prefix: process.env.QUEUE_PREFIX });
const claimed = await new Dispatcher(ds, qs).claimDue();
process.stdout.write(`claimed ${claimed.length}\n`);
process.kill(process.pid, 'SIGKILL');
