import { Check, Column, Entity, Index } from 'typeorm';
import { BaseRow } from './base.js';

/** Tenant root. Every other table carries `merchant_id` → merchants.id. */
@Entity({ name: 'merchants' })
@Check('merchants_name_not_blank', `length(btrim(name)) > 0`)
@Check('merchants_slug_format', `slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'`)
export class MerchantEntity extends BaseRow {
  @Column({ type: 'text' })
  name!: string;

  @Index('merchants_slug_key', { unique: true })
  @Column({ type: 'text' })
  slug!: string;
}
