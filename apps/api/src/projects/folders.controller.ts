import { CreateFolderBody, FolderParams, FolderSourcesBody } from '@myvideo/contracts';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
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
  create(@CurrentMerchant() m: string, @Body(new ZodPipe(CreateFolderBody)) b: { title: string }) {
    return this.folders.create(m, b.title);
  }
  @Get(':id')
  get(@CurrentMerchant() m: string, @Param(new ZodPipe(FolderParams)) p: { id: string }) {
    return this.folders.get(m, p.id);
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
