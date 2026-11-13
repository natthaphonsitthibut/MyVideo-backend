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
import { VideoSourceEntity } from './video-source.entity.js';

/** IDs are UUIDv7 minted by the folder service, like upload source IDs. */
abstract class FolderRow {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity({ name: 'project_folders' })
@Check('project_folders_title_check', 'length(btrim(title)) BETWEEN 1 AND 200')
@Check('project_folders_settings_check', "jsonb_typeof(settings) = 'object'")
@Unique('project_folders_id_merchant_id_key', ['id', 'merchantId'])
@Index('project_folders_merchant_updated_idx', ['merchantId', 'updatedAt'])
export class ProjectFolderEntity extends FolderRow {
  @Column({ name: 'merchant_id', type: 'uuid' })
  merchantId!: string;
  @ManyToOne(() => MerchantEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'merchant_id', foreignKeyConstraintName: 'project_folders_merchant_id_fkey' })
  merchant?: MerchantEntity;
  @Column({ type: 'text' })
  title!: string;
  @Column({ type: 'jsonb', default: {} })
  settings!: Record<string, unknown>;
}

@Entity({ name: 'project_folder_sources' })
@Unique('project_folder_sources_folder_id_source_id_key', ['folderId', 'sourceId'])
@Index('project_folder_sources_merchant_idx', ['merchantId'])
@Index('project_folder_sources_source_idx', ['sourceId', 'merchantId'])
export class ProjectFolderSourceEntity extends FolderRow {
  @Column({ name: 'merchant_id', type: 'uuid' })
  merchantId!: string;
  @ManyToOne(() => MerchantEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'merchant_id', foreignKeyConstraintName: 'project_folder_sources_merchant_id_fkey' })
  merchant?: MerchantEntity;
  @Column({ name: 'folder_id', type: 'uuid' })
  folderId!: string;
  @ManyToOne(() => ProjectFolderEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn([
    {
      name: 'folder_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'project_folder_sources_folder_id_merchant_id_fkey',
    },
    {
      name: 'merchant_id',
      referencedColumnName: 'merchantId',
      foreignKeyConstraintName: 'project_folder_sources_folder_id_merchant_id_fkey',
    },
  ])
  folder?: ProjectFolderEntity;
  @Column({ name: 'source_id', type: 'uuid' })
  sourceId!: string;
  @ManyToOne(() => VideoSourceEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn([
    {
      name: 'source_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'project_folder_sources_source_id_merchant_id_fkey',
    },
    {
      name: 'merchant_id',
      referencedColumnName: 'merchantId',
      foreignKeyConstraintName: 'project_folder_sources_source_id_merchant_id_fkey',
    },
  ])
  source?: VideoSourceEntity;
}
