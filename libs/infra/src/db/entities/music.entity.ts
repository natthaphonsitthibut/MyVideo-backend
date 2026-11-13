import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseRow } from './base.js';
import { MerchantEntity } from './merchant.entity.js';
@Entity({ name: 'merchant_music' })
@Check('merchant_music_status_valid', "status IN ('processing','ready','failed')")
@Check('merchant_music_size_valid', 'size_bytes > 0')
@Check('merchant_music_duration_valid', 'duration_ms IS NULL OR duration_ms > 0')
@Index('merchant_music_merchant_idx', ['merchantId'])
export class MusicEntity extends BaseRow {
  @Column({ name: 'merchant_id', type: 'uuid' }) merchantId!: string;
  @ManyToOne(() => MerchantEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'merchant_id', foreignKeyConstraintName: 'merchant_music_merchant_fkey' })
  merchant?: MerchantEntity;
  @Column({ type: 'text' }) title!: string;
  @Column({ name: 'storage_key', type: 'text' }) storageKey!: string;
  @Column({ type: 'text' }) sha256!: string;
  @Column({ name: 'size_bytes', type: 'bigint' }) sizeBytes!: string;
  @Column({ type: 'text' }) license!: string;
  @Column({ name: 'content_type', type: 'text' }) contentType!: string;
  @Column({ type: 'text', default: 'processing' }) status!: 'processing' | 'ready' | 'failed';
  @Column({ name: 'duration_ms', type: 'integer', nullable: true }) durationMs!: number | null;
  @Column({ type: 'jsonb', nullable: true }) analysis!: Record<string, unknown> | null;
  @Column({ type: 'text', nullable: true }) error!: string | null;
}
