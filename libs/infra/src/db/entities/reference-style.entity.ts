import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseRow } from './base.js';
import { MerchantEntity } from './merchant.entity.js';
import { VideoSourceEntity } from './video-source.entity.js';
@Entity({ name: 'reference_styles' })
@Index('reference_styles_source_key', ['sourceId'], { unique: true })
@Index('reference_styles_merchant_idx', ['merchantId'])
@Check('reference_styles_status_valid', "status IN ('waiting','processing','ready','failed')")
export class ReferenceStyleEntity extends BaseRow {
  @Column({ name: 'merchant_id', type: 'uuid' }) merchantId!: string;
  @ManyToOne(() => MerchantEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'merchant_id', foreignKeyConstraintName: 'reference_styles_merchant_fkey' })
  merchant?: MerchantEntity;
  @Column({ name: 'source_id', type: 'uuid' }) sourceId!: string;
  @ManyToOne(() => VideoSourceEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn([
    {
      name: 'source_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'reference_styles_source_merchant_fkey',
    },
    {
      name: 'merchant_id',
      referencedColumnName: 'merchantId',
      foreignKeyConstraintName: 'reference_styles_source_merchant_fkey',
    },
  ])
  source?: VideoSourceEntity;
  @Column({ type: 'text' }) title!: string;
  @Column({ type: 'text', default: 'waiting' }) status!: 'waiting' | 'processing' | 'ready' | 'failed';
  @Column({ name: 'run_id', type: 'uuid' }) runId!: string;
  @Column({ type: 'jsonb', nullable: true }) grammar!: Record<string, unknown> | null;
  @Column({ type: 'jsonb', nullable: true }) snapshot!: Record<string, unknown> | null;
  @Column({ type: 'text', nullable: true }) error!: string | null;
}
