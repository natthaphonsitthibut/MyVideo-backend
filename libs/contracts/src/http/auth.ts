import { z } from 'zod';
import { named } from '../registry.js';
import { defineRoute } from '../route.js';
import { ApiErrorBody } from './errors.js';

export const SESSION_COOKIE = 'myvideo_session';

export const LoginRequest = named(
  'LoginRequest',
  z.object({
    email: z.email().max(320),
    password: z.string().min(1).max(200),
  }),
);
export type LoginRequest = z.infer<typeof LoginRequest>;

export const Me = named(
  'Me',
  z.object({
    user: z.object({
      id: z.uuid(),
      email: z.string(),
      displayName: z.string(),
      role: z.enum(['owner', 'editor']),
    }),
    merchant: z.object({ id: z.uuid(), name: z.string(), slug: z.string() }),
  }),
  'The signed-in user and the merchant (tenant) every request is scoped to',
);
export type Me = z.infer<typeof Me>;

export const login = defineRoute({
  operationId: 'login',
  method: 'post',
  path: '/auth/login',
  summary: 'Sign in with email + password; sets the httpOnly session cookie',
  tags: ['auth'],
  auth: false,
  request: { body: LoginRequest },
  responses: {
    200: { description: 'Signed in', schema: Me },
    400: { description: 'Invalid request body', schema: ApiErrorBody },
    401: { description: 'Wrong email or password', schema: ApiErrorBody },
  },
});

export const logout = defineRoute({
  operationId: 'logout',
  method: 'post',
  path: '/auth/logout',
  summary: 'Sign out; revokes the session',
  tags: ['auth'],
  auth: true,
  responses: {
    204: { description: 'Signed out' },
    401: { description: 'Not signed in', schema: ApiErrorBody },
  },
});

export const getMe = defineRoute({
  operationId: 'getMe',
  method: 'get',
  path: '/auth/me',
  summary: 'Current user and merchant',
  tags: ['auth'],
  auth: true,
  responses: {
    200: { description: 'Signed in', schema: Me },
    401: { description: 'Not signed in', schema: ApiErrorBody },
  },
});
