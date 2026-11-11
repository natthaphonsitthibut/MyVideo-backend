import { MerchantEntity } from './merchant.entity.js';
import { UserEntity } from './user.entity.js';

export { MerchantEntity, UserEntity };
/** Every entity, listed explicitly (no globs: ESM + bundling safe). */
export const entities = [MerchantEntity, UserEntity];
