import { MerchantEntity } from './merchant.entity.js';
import { SessionEntity } from './session.entity.js';
import { UserEntity } from './user.entity.js';

export { MerchantEntity, SessionEntity, UserEntity };
/** Every entity, listed explicitly (no globs: ESM + bundling safe). */
export const entities = [MerchantEntity, UserEntity, SessionEntity];
