import {
  ChooseFolderStyleBody,
  CreateFolderBody,
  FolderParams,
  type FolderSettings,
  FolderSourcesBody,
  StartFolderEditBody,
  UpdateFolderBody,
} from '@myvideo/contracts';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { CurrentMerchant } from '../auth/auth-context.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { FoldersService } from './folders.service.js';

@Controller('folders')
export class FoldersController {
  constructor(@Inject(FoldersService) private readonly folders: FoldersService) {}
  @Get()
  list(@CurrentMerchant() m: string) {
    return this.folders.list(m);
  }
  @Post()
  @HttpCode(201)
  create(
    @CurrentMerchant() m: string,
    @Body(new ZodPipe(CreateFolderBody)) b: { title: string; settings?: FolderSettings },
  ) {
    return this.folders.create(m, b.title, b.settings);
  }
  @Get(':id')
  get(@CurrentMerchant() m: string, @Param(new ZodPipe(FolderParams)) p: { id: string }) {
    return this.folders.get(m, p.id);
  }
  @Patch(':id')
  update(
    @CurrentMerchant() m: string,
    @Param(new ZodPipe(FolderParams)) p: { id: string },
    @Body(new ZodPipe(UpdateFolderBody)) b: { title?: string; settings?: FolderSettings },
  ) {
    return this.folders.update(m, p.id, b);
  }
  @Get(':id/plan')
  plan(@CurrentMerchant() m: string, @Param(new ZodPipe(FolderParams)) p: { id: string }) {
    return this.folders.plan(m, p.id);
  }
  @Post(':id/edit')
  @HttpCode(200)
  startEdit(
    @CurrentMerchant() m: string,
    @Param(new ZodPipe(FolderParams)) p: { id: string },
    @Body(new ZodPipe(StartFolderEditBody)) b: { styleId?: string; sourceIds?: string[] },
  ) {
    return this.folders.startEdit(m, p.id, b.styleId, b.sourceIds);
  }
  @Post(':id/style')
  @HttpCode(200)
  chooseStyle(
    @CurrentMerchant() m: string,
    @Param(new ZodPipe(FolderParams)) p: { id: string },
    @Body(new ZodPipe(ChooseFolderStyleBody)) b: { styleId: string },
  ) {
    return this.folders.chooseStyle(m, p.id, b.styleId);
  }
  @Post(':id/sources')
  @HttpCode(200)
  add(
    @CurrentMerchant() m: string,
    @Param(new ZodPipe(FolderParams)) p: { id: string },
    @Body(new ZodPipe(FolderSourcesBody)) b: { sourceIds: string[] },
  ) {
    return this.folders.addSources(m, p.id, b.sourceIds);
  }
  @Delete(':id')
  @HttpCode(204)
  delete(@CurrentMerchant() m: string, @Param(new ZodPipe(FolderParams)) p: { id: string }) {
    return this.folders.delete(m, p.id);
  }
}
