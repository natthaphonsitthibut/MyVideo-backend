import { ASSET_KINDS, type AssetKind } from '@myvideo/domain';
import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseRow } from './base.js';
import { MerchantEntity } from './merchant.entity.js';
import { VideoSourceEntity } from './video-source.entity.js';

/** A stored file of a source: the original or a derived, re-creatable file with its recipe version. */
@Entity({ name: 'media_assets' })
@Check('media_assets_kind_valid', `kind IN (${ASSET_KINDS.map((s) => `'${s}'`).join(', ')})`)
@Check('media_assets_recipe_valid', `recipe_version >= 1`)
@Index('media_assets_source_kind_recipe_key', ['sourceId', 'kind', 'recipeVersion'], { unique: true })
@Index('media_assets_storage_key_key', ['storageKey'], { unique: true })
@Index('media_assets_merchant_id_idx', ['merchantId'])
export class MediaAssetEntity extends BaseRow {
  @Column({ name: 'merchant_id', type: 'uuid' })
  merchantId!: string;

  @ManyToOne(() => MerchantEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'merchant_id', foreignKeyConstraintName: 'media_assets_merchant_id_fkey' })
  merchant?: MerchantEntity;

  @Column({ name: 'source_id', type: 'uuid' })
  sourceId!: string;

  @ManyToOne(() => VideoSourceEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'source_id', foreignKeyConstraintName: 'media_assets_source_id_fkey' })
  source?: VideoSourceEntity;

  @Column({ type: 'text' })
  kind!: AssetKind;

  @Column({ name: 'recipe_version', type: 'integer', default: 1 })
  recipeVersion!: number;

  @Column({ name: 'storage_key', type: 'text' })
  storageKey!: string;

  @Column({ name: 'size_bytes', type: 'bigint' })
  sizeBytes!: string;

  @Column({ type: 'text' })
  sha256!: string;

  @Column({ name: 'content_type', type: 'text' })
  contentType!: string;

  @Column({ type: 'jsonb', default: {} })
  meta!: Record<string, unknown>;
}
