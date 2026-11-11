import { createHash, randomBytes } from 'node:crypto';
import { SessionEntity } from '@myvideo/infra';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { AuthContext } from './auth-context.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const SESSION_TTL_MS = 14 * DAY_MS;

const hashToken = (token: string) => createHash('sha256').update(token).digest();

@Injectable()
export class SessionService {
  constructor(@Inject(DataSource) private readonly ds: DataSource) {}

  /** Returns the cookie token. Only its hash is stored. Also drops this user's expired sessions. */
  async create(userId: string, merchantId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.ds.transaction(async (em) => {
      await em
        .createQueryBuilder()
        .delete()
        .from(SessionEntity)
        .where('user_id = :userId AND expires_at < now()', { userId })
        .execute();
      await em.insert(SessionEntity, {
        tokenHash: hashToken(token),
        userId,
        merchantId,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      });
    });
    return token;
  }

  /** Valid, unexpired session → auth context. Sliding expiry: extended when less than half its life is left. */
  async resolve(token: string): Promise<AuthContext | null> {
    if (!token || token.length > 100) return null;
    const row = await this.ds.getRepository(SessionEntity).findOneBy({ tokenHash: hashToken(token) });
    if (!row || row.expiresAt.getTime() <= Date.now()) return null;
    if (row.expiresAt.getTime() - Date.now() < SESSION_TTL_MS / 2) {
      await this.ds
        .getRepository(SessionEntity)
        .update({ id: row.id }, { expiresAt: new Date(Date.now() + SESSION_TTL_MS) });
    }
    return { sessionId: row.id, userId: row.userId, merchantId: row.merchantId };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.ds.getRepository(SessionEntity).delete({ id: sessionId });
  }
}
