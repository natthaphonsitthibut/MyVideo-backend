import { SOURCE_STATUSES, type SourceStatus } from '@myvideo/domain';
import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { MerchantEntity } from './merchant.entity.js';

/** One uploaded video and everything known about it. The original file is immutable (ARCHITECTURE §4). */
@Entity({ name: 'video_sources' })
@Unique('video_sources_id_merchant_key', ['id', 'merchantId'])
@Check('video_sources_status_valid', `status IN (${SOURCE_STATUSES.map((s) => `'${s}'`).join(', ')})`)
@Check('video_sources_size_valid', `size_bytes > 0`)
@Check('video_sources_title_not_blank', `length(btrim(title)) > 0`)
@Index('video_sources_merchant_upload_key', ['merchantId', 'uploadId'], { unique: true })
@Index('video_sources_merchant_created_idx', ['merchantId', 'createdAt'])
export class VideoSourceEntity {
  /** Minted when the upload starts (so finishing is idempotent). */
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'merchant_id', type: 'uuid' })
  merchantId!: string;

  @ManyToOne(() => MerchantEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'merchant_id', foreignKeyConstraintName: 'video_sources_merchant_id_fkey' })
  merchant?: MerchantEntity;

  /** The resumable-upload id that produced this source. */
  @Column({ name: 'upload_id', type: 'text' })
  uploadId!: string;

  @Column({ type: 'text' })
  title!: string;

  @Column({ name: 'original_filename', type: 'text' })
  originalFilename!: string;

  @Column({ type: 'text', default: 'processing' })
  status!: SourceStatus;

  @Column({ name: 'size_bytes', type: 'bigint' })
  sizeBytes!: string;

  @Column({ type: 'text' })
  sha256!: string;

  /** Normalised probe result (frames, fps rational, size, rotation, codecs…), filled by the probe step. */
  @Column({ type: 'jsonb', nullable: true })
  probe!: Record<string, unknown> | null;

  /** User-readable reason when ingest failed (Thai). */
  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
