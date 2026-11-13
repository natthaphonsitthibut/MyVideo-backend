import {
  AiServiceClient,
  ChromiumRenderer,
  clipsRestyleHandler,
  createDataSource,
  createLlm,
  createStorage,
  DbLlmCallStore,
  Dispatcher,
  type Env,
  folderAdvanceHandler,
  HandlerRegistry,
  ingestHandlers,
  JobRunner,
  liveToClipsHandlers,
  loadStageBundle,
  purgeHandler,
  QueueSet,
  QueueWorkers,
  renderHandler,
  reviewBuildHandler,
  StageTextLayout,
  selectedClipsHandler,
  shotsHandler,
  systemHandlers,
  transcribeHandlers,
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
          useFactory: async (ds: DataSource) => handlers ?? (await defaultHandlers(env, ds)),
        },
        WorkerLifecycle,
      ],
    };
  }
}

export async function defaultHandlers(env: Env, ds: DataSource): Promise<HandlerRegistry> {
  const registry = new HandlerRegistry();
  for (const h of systemHandlers) registry.register(h);
  registry.register(purgeHandler(createStorage(env)));
  const ingest = ingestHandlers({
    ds,
    storage: createStorage(env),
    proxyEncoder: env.PROXY_ENCODER,
    proxySegmentSeconds: env.PROXY_SEGMENT_SECONDS,
  });
  for (const h of ingest) registry.register(h);
  const transcribe = transcribeHandlers({
    ds,
    llm: createLlm(env, new DbLlmCallStore(ds)),
    storage: createStorage(env),
    ai: new AiServiceClient({ baseUrl: env.AI_SERVICE_URL }),
  });
  for (const h of transcribe) registry.register(h);
  registry.register(
    shotsHandler({
      ds,
      storage: createStorage(env),
      ai: new AiServiceClient({ baseUrl: env.AI_SERVICE_URL }),
    }),
  );
  // the stage bundle is verified once at start; a broken or missing bundle stops the worker loudly
  const bundle = await loadStageBundle();
  registry.register(
    selectedClipsHandler({
      ds,
      storage: createStorage(env),
      ai: new AiServiceClient({ baseUrl: env.AI_SERVICE_URL }),
      openLayout: () => StageTextLayout.open(bundle),
    }),
  );
  const renderer = new ChromiumRenderer(bundle);
  const clips = liveToClipsHandlers({
    ds,
    storage: createStorage(env),
    ai: new AiServiceClient({ baseUrl: env.AI_SERVICE_URL }),
    llm: createLlm(env, new DbLlmCallStore(ds)),
    openLayout: () => StageTextLayout.open(bundle),
  });
  for (const h of clips) registry.register(h);
  registry.register(clipsRestyleHandler({ ds, openLayout: () => StageTextLayout.open(bundle) }));
  registry.register(folderAdvanceHandler({ ds }));
  registry.register(
    reviewBuildHandler({
      ds,
      storage: createStorage(env),
      ai: new AiServiceClient({ baseUrl: env.AI_SERVICE_URL }),
      openLayout: () => StageTextLayout.open(bundle),
    }),
  );
  registry.register(
    renderHandler({ ds, storage: createStorage(env), renderer, soundLibraryDir: env.SOUND_LIBRARY_DIR }),
  );
  return registry;
}
