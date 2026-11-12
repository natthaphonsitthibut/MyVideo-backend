import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseRow } from './base.js';
import { MerchantEntity } from './merchant.entity.js';

/**
 * The merchant's brand kit (E08-F08): one row per merchant. Projects reference it through style tokens, never a
 * copy, so a change restyles every project on its next preview/render.
 */
@Entity({ name: 'brand_kits' })
@Index('brand_kits_merchant_id_key', ['merchantId'], { unique: true })
@Check(
  'brand_kits_colors_valid',
  `primary_color ~ '^#[0-9a-fA-F]{6}$' AND accent_color ~ '^#[0-9a-fA-F]{6}$' AND text_color ~ '^#[0-9a-fA-F]{6}$'`,
)
@Check('brand_kits_cta_valid', `char_length(default_cta) BETWEEN 1 AND 40`)
export class BrandKitEntity extends BaseRow {
  @Column({ name: 'merchant_id', type: 'uuid' })
  merchantId!: string;

  // ManyToOne + the unique index above: one kit per merchant without a second UNIQUE constraint
  @ManyToOne(() => MerchantEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'merchant_id', foreignKeyConstraintName: 'brand_kits_merchant_id_fkey' })
  merchant?: MerchantEntity;

  @Column({ name: 'primary_color', type: 'text' })
  primaryColor!: string;

  @Column({ name: 'accent_color', type: 'text' })
  accentColor!: string;

  @Column({ name: 'text_color', type: 'text' })
  textColor!: string;

  @Column({ type: 'text' })
  font!: string;

  @Column({ name: 'default_cta', type: 'text' })
  defaultCta!: string;

  /** Storage key of the logo image; null = no logo. */
  @Column({ name: 'logo_key', type: 'text', nullable: true })
  logoKey!: string | null;

  @Column({ name: 'logo_content_type', type: 'text', nullable: true })
  logoContentType!: string | null;
}
