import type { Env } from '@myvideo/infra';
import {
  type DynamicModule,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

/** Keeps the process alive and reports start/stop. Queue processors are added in E02. */
@Injectable()
export class WorkerLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerLifecycle.name);
  private keepAlive: NodeJS.Timeout | undefined;

  onApplicationBootstrap(): void {
    this.keepAlive = setInterval(() => undefined, 60_000);
    this.logger.log('worker ready');
  }

  onApplicationShutdown(signal?: string): void {
    clearInterval(this.keepAlive);
    this.logger.log(`worker stopped${signal ? ` (${signal})` : ''}`);
  }
}

@Module({})
export class WorkerModule {
  static forRoot(env: Env): DynamicModule {
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
      providers: [WorkerLifecycle],
    };
  }
}
