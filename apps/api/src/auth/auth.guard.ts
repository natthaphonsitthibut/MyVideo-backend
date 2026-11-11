import { SESSION_COOKIE } from '@myvideo/contracts';
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type AuthedRequest, IS_PUBLIC } from './auth-context.js';
import { readCookie } from './cookies.js';
import { SessionService } from './session.service.js';

/** Global guard: every route needs a valid session cookie unless marked `@Public()`. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    const auth = token ? await this.sessions.resolve(token) : null;
    if (auth) req.auth = auth;
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    if (!auth) throw new UnauthorizedException('Sign in required');
    return true;
  }
}
