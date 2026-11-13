import { Module } from '@nestjs/common';
import { MusicController } from './music.controller.js';
@Module({ controllers: [MusicController] })
export class MusicModule {}
