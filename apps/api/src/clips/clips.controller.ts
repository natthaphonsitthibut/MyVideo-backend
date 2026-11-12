import {
  type ClipSuggestion,
  ClipSuggestionParams,
  type ClipsState,
  GenerateClipsBody,
  ProjectIdParams,
  RestyleBody,
  SourceIdParams,
} from '@myvideo/contracts';
import { Body, Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { CurrentMerchant } from '../auth/auth-context.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { ClipsService } from './clips.service.js';

@Controller()
export class ClipsController {
  constructor(@Inject(ClipsService) private readonly clips: ClipsService) {}

  @Get('sources/:id/clips')
  state(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(SourceIdParams)) p: { id: string },
  ): Promise<ClipsState> {
    return this.clips.state(merchantId, p.id);
  }

  @Post('sources/:id/clips')
  @HttpCode(202)
  generate(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(SourceIdParams)) p: { id: string },
    @Body(new ZodPipe(GenerateClipsBody)) body: { productName?: string; fresh?: boolean; styleId?: string },
  ): Promise<ClipsState> {
    return this.clips.generate(merchantId, p.id, body);
  }

  @Get('style-packs')
  styles(): { items: { id: string; name: string; description: string }[] } {
    return this.clips.listStyles();
  }

  @Post('projects/:id/restyle')
  @HttpCode(202)
  restyle(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(ProjectIdParams)) p: { id: string },
    @Body(new ZodPipe(RestyleBody)) body: { styleId: string },
  ): Promise<{ runId: string }> {
    return this.clips.restyle(merchantId, p.id, body.styleId);
  }

  @Post('clip-suggestions/:id/discard')
  @HttpCode(200)
  discard(
    @CurrentMerchant() merchantId: string,
    @Param(new ZodPipe(ClipSuggestionParams)) p: { id: string },
  ): Promise<ClipSuggestion> {
    return this.clips.discard(merchantId, p.id);
  }
}
