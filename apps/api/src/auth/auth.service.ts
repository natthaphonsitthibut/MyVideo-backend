import type { Me } from '@myvideo/contracts';
import { MerchantEntity, UserEntity, verifyPassword } from '@myvideo/infra';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

// Verified against when the email is unknown, so both paths cost one scrypt (no user enumeration by timing).
const DUMMY_HASH = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

@Injectable()
export class AuthService {
  constructor(@Inject(DataSource) private readonly ds: DataSource) {}

  async verifyCredentials(email: string, password: string): Promise<UserEntity | null> {
    const user = await this.ds.getRepository(UserEntity).findOneBy({ email: email.trim().toLowerCase() });
    const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
    return user && ok ? user : null;
  }

  async me(userId: string, merchantId: string): Promise<Me> {
    const user = await this.ds.getRepository(UserEntity).findOneBy({ id: userId, merchantId });
    const merchant = await this.ds.getRepository(MerchantEntity).findOneBy({ id: merchantId });
    if (!user || !merchant) throw new NotFoundException();
    return {
      user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
      merchant: { id: merchant.id, name: merchant.name, slug: merchant.slug },
    };
  }
}
