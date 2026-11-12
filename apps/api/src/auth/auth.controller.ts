import { LoginRequest, type Me, SESSION_COOKIE } from '@myvideo/contracts';
import type { Env } from '@myvideo/infra';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { FixedWindowLimiter } from '../common/rate-limit.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { ENV } from '../config/env.module.js';
import { AuthService } from './auth.service.js';
import { type AuthContext, CurrentAuth, Public } from './auth-context.js';
import { sessionCookie } from './cookies.js';
import { SESSION_TTL_MS, SessionService } from './session.service.js';

const FIFTEEN_MIN = 15 * 60_000;

@Controller('auth')
export class AuthController {
  private readonly byAccount = new FixedWindowLimiter({ limit: 10, windowMs: FIFTEEN_MIN });
  private readonly byIp = new FixedWindowLimiter({ limit: 50, windowMs: FIFTEEN_MIN });

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
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Me> {
    // brute force: failed attempts per account and per address (E11-F02); a success forgets the account's failures
    const account = body.email.trim().toLowerCase();
    const ip = req.ip ?? 'unknown';
    if (!this.byAccount.hit(account) || !this.byIp.hit(ip)) {
      res.setHeader(
        'retry-after',
        String(Math.max(this.byAccount.retryAfterSeconds(account), this.byIp.retryAfterSeconds(ip))),
      );
      throw new HttpException('ลองเข้าสู่ระบบบ่อยเกินไป รอสักครู่แล้วลองใหม่', HttpStatus.TOO_MANY_REQUESTS);
    }
    const user = await this.auth.verifyCredentials(body.email, body.password);
    if (!user) throw new UnauthorizedException('Wrong email or password');
    this.byAccount.reset(account);
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
