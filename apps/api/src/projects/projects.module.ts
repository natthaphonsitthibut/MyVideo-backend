import { Module } from '@nestjs/common';
import { FoldersController } from './folders.controller.js';
import { FoldersService } from './folders.service.js';
import { ProjectsController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';

@Module({
  controllers: [ProjectsController, FoldersController],
  providers: [ProjectsService, FoldersService],
})
export class ProjectsModule {}
