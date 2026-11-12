import {
  CreateReviewVideoBody,
  ProjectIdParams,
  type ReviewVideoState,
  RunIdParams,
  SwapTemplateBody,
  type TemplateVersion,
} from '@myvideo/contracts';
import type { ReviewInput } from '@myvideo/infra';
import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { CurrentMerchant } from '../auth/auth-context.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { ReviewVideosService } from './review-videos.service.js';

/** Review-to-Video (E10): templates, start a run from several clips, its result, and swapping the template. */
@Controller()
export class ReviewVideosController {
  constructor(@Inject(ReviewVideosService) private readonly svc: ReviewVideosService) {}

  @Get('templates')
  templates(): { items: TemplateVersion[] } {
    return this.svc.templates();
  }

  @Post('review-videos')
  @HttpCode(202)
  create(
    @CurrentMerchant() merchantId: string,
    @Body(new ZodPipe(CreateReviewVideoBody)) body: Pick<
      ReviewInput,
      'sourceIds' | 'templateId' | 'product' | 'roles'
    >,
  ): Promise<ReviewVideoState> {
    return this.svc.create(merchantId, body);
  }

  @Get('review-videos/:id')
  state(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(RunIdParams)) p: { id: string },
  ): Promise<ReviewVideoState> {
    return this.svc.state(merchantId, p.id);
  }

  @Post('projects/:id/template')
  @HttpCode(202)
  swap(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(ProjectIdParams)) p: { id: string },
    @Body(new ZodPipe(SwapTemplateBody)) body: { templateId: string },
  ): Promise<ReviewVideoState> {
    return this.svc.swap(merchantId, p.id, body.templateId);
  }
}
