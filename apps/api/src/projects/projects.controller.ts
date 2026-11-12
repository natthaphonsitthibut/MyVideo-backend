import {
  CreateProjectBody,
  type ProjectDraft,
  ProjectIdParams,
  type ProjectList,
  type ProjectRecord,
  type ProjectVersionDoc,
  type ProjectVersionList,
  RestoreBody,
  RestoreParams,
  SaveProjectBody,
} from '@myvideo/contracts';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import type { z } from 'zod';
import { CurrentMerchant } from '../auth/auth-context.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { ProjectsService } from './projects.service.js';

@Controller('projects')
export class ProjectsController {
  constructor(@Inject(ProjectsService) private readonly projects: ProjectsService) {}

  @Post()
  @HttpCode(201)
  create(
    @CurrentMerchant() merchantId: string,
    @Body(new ZodPipe(CreateProjectBody)) body: { title: string; doc: ProjectDraft },
  ): Promise<ProjectRecord> {
    return this.projects.create(merchantId, body.title, body.doc);
  }

  @Get()
  list(@CurrentMerchant() merchantId: string): Promise<z.infer<typeof ProjectList>> {
    return this.projects.list(merchantId);
  }

  @Get(':id')
  get(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(ProjectIdParams)) p: { id: string },
  ): Promise<ProjectRecord> {
    return this.projects.get(merchantId, p.id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(ProjectIdParams)) p: { id: string },
  ): Promise<void> {
    await this.projects.delete(merchantId, p.id);
  }

  @Put(':id')
  save(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(ProjectIdParams)) p: { id: string },
    @Body(new ZodPipe(SaveProjectBody)) body: { baseVersion: number; doc: ProjectDraft },
  ): Promise<ProjectRecord> {
    return this.projects.save(merchantId, p.id, body.baseVersion, body.doc);
  }

  @Get(':id/versions')
  versions(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(ProjectIdParams)) p: { id: string },
  ): Promise<z.infer<typeof ProjectVersionList>> {
    return this.projects.versions(merchantId, p.id);
  }

  @Get(':id/versions/:version')
  version(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(RestoreParams)) p: { id: string; version: number },
  ): Promise<z.infer<typeof ProjectVersionDoc>> {
    return this.projects.version(merchantId, p.id, p.version);
  }

  @Post(':id/versions/:version/restore')
  @HttpCode(200)
  restore(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(RestoreParams)) p: { id: string; version: number },
    @Body(new ZodPipe(RestoreBody)) body: { baseVersion: number },
  ): Promise<ProjectRecord> {
    return this.projects.restore(merchantId, p.id, p.version, body.baseVersion);
  }
}
