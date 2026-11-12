import { Module } from '@nestjs/common';
import { ReviewVideosController } from './review-videos.controller.js';
import { ReviewVideosService } from './review-videos.service.js';

@Module({
  controllers: [ReviewVideosController],
  providers: [ReviewVideosService],
})
export class ReviewVideosModule {}
