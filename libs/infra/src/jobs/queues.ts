import { QUEUES, type QueueName } from '@myvideo/domain';
import { Queue } from 'bullmq';

/** BullMQ carries only `{ jobId }`; Postgres has everything else (ARCHITECTURE §5.1). */
export type QueueMessage = { jobId: string };

export type QueueConfig = { redisUrl: string; prefix?: string };

export function redisConnection(redisUrl: string) {
  // Workers need maxRetriesPerRequest: null (blocking commands); harmless for producers.
  return { url: redisUrl, maxRetriesPerRequest: null };
}

/** The BullMQ job id for one dispatch of one attempt: re-adding the same attempt is a no-op in BullMQ. */
export function bullJobId(jobId: string, attempts: number): string {
  return `${jobId}.${attempts}`;
}

export class QueueSet {
  private readonly queues = new Map<QueueName, Queue<QueueMessage>>();

  constructor(cfg: QueueConfig) {
    for (const name of QUEUES) {
      this.queues.set(
        name,
        new Queue<QueueMessage>(name, {
          connection: redisConnection(cfg.redisUrl),
          prefix: cfg.prefix ?? 'myvideo',
          defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 1000, attempts: 1 },
        }),
      );
    }
  }

  get(name: QueueName): Queue<QueueMessage> {
    const q = this.queues.get(name);
    if (!q) throw new Error(`unknown queue ${name}`);
    return q;
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}
