import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseRow } from './base.js';
import { MerchantEntity } from './merchant.entity.js';
@Entity({ name: 'merchant_style_locks' })
@Index('merchant_style_locks_merchant_key', ['merchantId'], { unique: true })
export class StyleLockEntity extends BaseRow {
  @Column({ name: 'merchant_id', type: 'uuid' }) merchantId!: string;
  @ManyToOne(() => MerchantEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'merchant_id', foreignKeyConstraintName: 'merchant_style_locks_merchant_fkey' })
  merchant?: MerchantEntity;
  @Column({ type: 'jsonb' }) snapshot!: Record<string, unknown>;
}
