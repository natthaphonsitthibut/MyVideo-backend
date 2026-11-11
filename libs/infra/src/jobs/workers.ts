import type { QueueName } from '@myvideo/domain';
import { Worker } from 'bullmq';
import { type QueueMessage, redisConnection } from './queues.js';
import type { JobRunner } from './runner.js';

export type QueueWorkersConfig = {
  redisUrl: string;
  prefix?: string;
  concurrency: Record<QueueName, number>;
};

/** One BullMQ worker per queue; each message is handed to the runner (Postgres decides what happens). */
export class QueueWorkers {
  private readonly workers: Worker<QueueMessage>[] = [];

  constructor(
    private readonly cfg: QueueWorkersConfig,
    private readonly runner: JobRunner,
  ) {}

  start(queues: QueueName[]): void {
    for (const name of queues) {
      this.workers.push(
        new Worker<QueueMessage>(name, async (msg) => this.runner.run(msg.data.jobId), {
          connection: redisConnection(this.cfg.redisUrl),
          prefix: this.cfg.prefix ?? 'myvideo',
          concurrency: this.cfg.concurrency[name],
        }),
      );
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
  }
}
