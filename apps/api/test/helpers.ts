import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

/** Logs in through the real endpoint and returns the `Cookie` header value. */
export async function loginCookie(app: INestApplication, email: string, password: string): Promise<string> {
  const res = await request(app.getHttpServer()).post('/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const cookie = res.headers['set-cookie']?.[0];
  if (!cookie) throw new Error('no session cookie');
  return cookie.split(';')[0] ?? '';
}
