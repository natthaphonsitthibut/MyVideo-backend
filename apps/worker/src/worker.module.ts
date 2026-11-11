import {
  createDataSource,
  createStorage,
  Dispatcher,
  type Env,
  HandlerRegistry,
  ingestHandlers,
  JobRunner,
  QueueSet,
  QueueWorkers,
  systemHandlers,
} from '@myvideo/infra';
import {
  type DynamicModule,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { DataSource } from 'typeorm';

export const WORKER_ENV = Symbol('WORKER_ENV');
export const HANDLERS = Symbol('HANDLERS');

/** Starts the outbox dispatcher and one BullMQ worker per queue; stops them in reverse order. */
@Injectable()
export class WorkerLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerLifecycle.name);
  private queues!: QueueSet;
  private dispatcher!: Dispatcher;
  private workers!: QueueWorkers;

  constructor(
    @Inject(WORKER_ENV) private readonly env: Env,
    @Inject(DataSource) private readonly ds: DataSource,
    @Inject(HANDLERS) private readonly handlers: HandlerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    const prefix = this.env.QUEUE_PREFIX;
    this.queues = new QueueSet({ redisUrl: this.env.REDIS_URL, prefix });
    this.dispatcher = new Dispatcher(this.ds, this.queues, {
      pollMs: this.env.DISPATCH_POLL_MS,
      maxInflightPerMerchant: this.env.MERCHANT_MAX_INFLIGHT_JOBS,
      staleAfterMs: this.env.JOB_STALE_AFTER_MS,
      lostAfterMs: this.env.JOB_LOST_AFTER_MS,
      log: (msg, extra) => this.logger.warn({ ...extra }, msg),
    });
    this.workers = new QueueWorkers(
      {
        redisUrl: this.env.REDIS_URL,
        prefix,
        concurrency: {
          media: this.env.QUEUE_MEDIA_CONCURRENCY,
          ai: this.env.QUEUE_AI_CONCURRENCY,
          render: this.env.QUEUE_RENDER_CONCURRENCY,
        },
      },
      new JobRunner(this.ds, this.handlers, { heartbeatMs: this.env.JOB_HEARTBEAT_MS }),
    );
    const queues = this.handlers.queues();
    this.workers.start(queues);
    this.dispatcher.start();
    this.logger.log(`worker ready (queues: ${queues.join(', ')})`);
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    await this.dispatcher?.stop();
    await this.workers?.close();
    await this.queues?.close();
    if (this.ds.isInitialized) await this.ds.destroy();
    this.logger.log(`worker stopped${signal ? ` (${signal})` : ''}`);
  }
}

@Module({})
export class WorkerModule {
  static forRoot(env: Env, handlers?: HandlerRegistry): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            level: env.LOG_LEVEL,
            ...(env.LOG_PRETTY ? { transport: { target: 'pino-pretty' } } : {}),
          },
        }),
      ],
      providers: [
        { provide: WORKER_ENV, useValue: env },
        { provide: DataSource, useFactory: () => createDataSource(env.DATABASE_URL).initialize() },
        {
          provide: HANDLERS,
          inject: [DataSource],
          useFactory: (ds: DataSource) => handlers ?? defaultHandlers(env, ds),
        },
        WorkerLifecycle,
      ],
    };
  }
}

export function defaultHandlers(env: Env, ds: DataSource): HandlerRegistry {
  const registry = new HandlerRegistry();
  for (const h of systemHandlers) registry.register(h);
  for (const h of ingestHandlers({ ds, storage: createStorage(env) })) registry.register(h);
  return registry;
}
