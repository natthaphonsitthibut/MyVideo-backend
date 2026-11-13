import {
  ReferenceCreateBody,
  ReferenceParams,
  ReferenceStyleList,
  ReferenceStyleRecord,
} from '@myvideo/contracts';
import {
  createReference,
  lockStyle,
  ReferenceUnavailableError,
  referenceRecords,
  retryReference,
} from '@myvideo/infra';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Module,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CurrentMerchant } from '../auth/auth-context.js';
import { ZodPipe } from '../common/zod-pipe.js';
@Controller('reference-styles')
export class ReferenceController {
  constructor(@Inject(DataSource) private readonly ds: DataSource) {}
  @Get() async list(@CurrentMerchant() m: string) {
    return ReferenceStyleList.parse({ items: await referenceRecords(this.ds, m) });
  }
  @Post(':id/lock') @HttpCode(204) async lock(
    @CurrentMerchant() m: string,
    @Param(new ZodPipe(ReferenceParams)) p: { id: string },
  ) {
    const record = await this.record(m, p.id);
    if (record.status !== 'ready' || !record.styleId) throw new ConflictException('รอวิเคราะห์สไตล์ให้เสร็จก่อน');
    await lockStyle(this.ds, m, record.styleId);
  }
  private async record(m: string, id: string) {
    const r = (await referenceRecords(this.ds, m)).find((r) => r.id === id);
    if (!r) throw new NotFoundException('ไม่พบคลิปอ้างอิง');
    return ReferenceStyleRecord.parse(r);
  }
  private fail(error: unknown): never {
    if (error instanceof ReferenceUnavailableError) {
      if (error.reason === 'not_found') throw new NotFoundException(error.message);
      if (error.reason === 'used') throw new ConflictException(error.message);
      throw new BadRequestException(error.message);
    }
    throw error;
  }
  @Post() @HttpCode(202) async create(
    @CurrentMerchant() m: string,
    @Body(new ZodPipe(ReferenceCreateBody)) b: { sourceId: string; title: string },
  ) {
    try {
      return await this.record(m, await createReference(this.ds, m, b.sourceId, b.title));
    } catch (e) {
      return this.fail(e);
    }
  }
  @Post(':id/retry') @HttpCode(202) async retry(
    @CurrentMerchant() m: string,
    @Param(new ZodPipe(ReferenceParams)) p: { id: string },
  ) {
    try {
      await retryReference(this.ds, m, p.id);
      return await this.record(m, p.id);
    } catch (e) {
      return this.fail(e);
    }
  }
}
@Module({ controllers: [ReferenceController] })
export class ReferenceModule {}
