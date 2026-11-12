import { loadStageBundle } from '@myvideo/infra';
import { Module } from '@nestjs/common';
import { RendersController } from './renders.controller.js';
import { RendersService, STAGE_BUNDLE } from './renders.service.js';

@Module({
  controllers: [RendersController],
  providers: [
    // the stage version a render request pins (same synced bundle the worker renders with)
    { provide: STAGE_BUNDLE, useFactory: () => loadStageBundle() },
    RendersService,
  ],
})
export class RendersModule {}
