import { LoginRequest, type Me, SESSION_COOKIE } from '@myvideo/contracts';
import type { Env } from '@myvideo/infra';
import { Body, Controller, Get, HttpCode, Inject, Post, Res, UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import { ZodPipe } from '../common/zod-pipe.js';
import { ENV } from '../config/env.module.js';
import { AuthService } from './auth.service.js';
import { type AuthContext, CurrentAuth, Public } from './auth-context.js';
import { sessionCookie } from './cookies.js';
import { SESSION_TTL_MS, SessionService } from './session.service.js';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private setCookie(res: Response, token: string, maxAgeSeconds: number): void {
    res.setHeader(
      'Set-Cookie',
      sessionCookie(SESSION_COOKIE, token, { maxAgeSeconds, secure: this.env.NODE_ENV === 'production' }),
    );
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodPipe(LoginRequest)) body: LoginRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Me> {
    const user = await this.auth.verifyCredentials(body.email, body.password);
    if (!user) throw new UnauthorizedException('Wrong email or password');
    const token = await this.sessions.create(user.id, user.merchantId);
    this.setCookie(res, token, SESSION_TTL_MS / 1000);
    return this.auth.me(user.id, user.merchantId);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentAuth() auth: AuthContext, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.sessions.revoke(auth.sessionId);
    this.setCookie(res, '', 0);
  }

  @Get('me')
  me(@CurrentAuth() auth: AuthContext): Promise<Me> {
    return this.auth.me(auth.userId, auth.merchantId);
  }
}
