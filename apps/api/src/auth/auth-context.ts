import {
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

export type AuthContext = { sessionId: string; userId: string; merchantId: string };
export type AuthedRequest = Request & { auth?: AuthContext };

export const IS_PUBLIC = 'myvideo:isPublic';
/** Marks a handler/controller as reachable without a session (default: every route needs one). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

function authOf(ctx: ExecutionContext): AuthContext {
  const auth = ctx.switchToHttp().getRequest<AuthedRequest>().auth;
  if (!auth) throw new UnauthorizedException();
  return auth;
}

/** The merchant (tenant) of the signed-in user. Every tenant query must be scoped by it. */
export const CurrentMerchant = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => authOf(ctx).merchantId,
);
export const CurrentAuth = createParamDecorator((_: unknown, ctx: ExecutionContext) => authOf(ctx));
