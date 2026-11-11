import { Module } from '@nestjs/common';
import { NotifyHub } from './notify-hub.js';
import { RunsController } from './runs.controller.js';
import { RunsService } from './runs.service.js';

@Module({ controllers: [RunsController], providers: [RunsService, NotifyHub] })
export class RunsModule {}
