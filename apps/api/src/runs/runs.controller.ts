import {
  ListRunsQuery,
  RunIdParams,
  type RunList,
  type RunSummary,
  TestRunRequest,
} from '@myvideo/contracts';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CurrentMerchant } from '../auth/auth-context.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { NotifyHub } from './notify-hub.js';
import { RunsService, toRunEvent } from './runs.service.js';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

@Controller('workflow-runs')
export class RunsController {
  constructor(
    @Inject(RunsService) private readonly runs: RunsService,
    @Inject(NotifyHub) private readonly hub: NotifyHub,
  ) {}

  @Get()
  list(
    @CurrentMerchant() merchantId: string,
    @Query(new ZodPipe(ListRunsQuery)) q: { limit: number; before?: string },
  ): Promise<RunList> {
    return this.runs.list(merchantId, q.limit, q.before);
  }

  @Post('test')
  @HttpCode(201)
  createTest(
    @CurrentMerchant() merchantId: string,
    @Body(new ZodPipe(TestRunRequest)) body: { ms: number; steps: number; failFirstAttempt: boolean },
  ): Promise<RunSummary> {
    return this.runs.createTestRun(merchantId, body);
  }

  @Get(':id')
  get(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(RunIdParams)) p: { id: string },
  ): Promise<RunSummary> {
    return this.runs.get(merchantId, p.id);
  }

  /**
   * SSE. Replays events after Last-Event-ID (header, or `lastEventId` query for EventSource-less clients), then
   * streams new ones as the triggers NOTIFY. Ends with `event: end` once the run is terminal and drained.
   */
  @Get(':id/events')
  async events(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(RunIdParams)) p: { id: string },
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const run = await this.runs.get(merchantId, p.id); // 404 for other merchants
    const fromHeader = req.headers['last-event-id'];
    const fromQuery = typeof req.query.lastEventId === 'string' ? req.query.lastEventId : undefined;
    let last = /^\d+$/.test(String(fromHeader ?? fromQuery ?? '')) ? String(fromHeader ?? fromQuery) : '0';
    res.status(200);
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders();
    res.write('retry: 2000\n\n');

    let closed = false;
    let draining = false;
    let again = false;
    let runDone = TERMINAL.has(run.status);
    const finish = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      clearInterval(ping);
      res.end();
    };
    const drain = async () => {
      if (closed) return;
      if (draining) {
        again = true;
        return;
      }
      draining = true;
      try {
        do {
          again = false;
          const rows = await this.runs.eventsAfter(merchantId, p.id, last);
          for (const e of rows) {
            res.write(`id: ${e.id}\nevent: ${e.kind}\ndata: ${JSON.stringify(toRunEvent(e))}\n\n`);
            last = e.id;
            // the latest run event decides (a retried run goes failed → pending → … again)
            if (e.kind === 'run') runDone = TERMINAL.has(e.status);
          }
          if (rows.length === 500) again = true;
        } while (again && !closed);
        if (runDone) {
          res.write(`event: end\ndata: {}\n\n`);
          finish();
        }
      } finally {
        draining = false;
      }
    };
    const unsubscribe = this.hub.subscribe(p.id, () => void drain());
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', finish);
    await drain();
  }
}
