import { Module } from '@nestjs/common';
import { NotifyHub } from './notify-hub.js';
import { RunsController } from './runs.controller.js';
import { RunsService } from './runs.service.js';
import { TimingsController } from './timings.controller.js';
import { TimingsService } from './timings.service.js';

@Module({
  controllers: [RunsController, TimingsController],
  providers: [RunsService, NotifyHub, TimingsService],
})
export class RunsModule {}
