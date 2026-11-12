import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseRow } from './base.js';
import { MerchantEntity } from './merchant.entity.js';

/**
 * An editable project (ARCHITECTURE §6). `current_version` moves only through a conditional update
 * (`… WHERE current_version = baseVersion`), which is the optimistic lock: of two saves on the same base, one wins.
 */
@Entity({ name: 'projects' })
@Check('projects_title_not_blank', `length(btrim(title)) > 0`)
@Check('projects_version_valid', `current_version >= 1`)
@Index('projects_merchant_updated_idx', ['merchantId', 'updatedAt'])
export class ProjectEntity extends BaseRow {
  @Column({ name: 'merchant_id', type: 'uuid' })
  merchantId!: string;

  @ManyToOne(() => MerchantEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'merchant_id', foreignKeyConstraintName: 'projects_merchant_id_fkey' })
  merchant?: MerchantEntity;

  @Column({ type: 'text' })
  title!: string;

  @Column({ name: 'current_version', type: 'integer', default: 1 })
  currentVersion!: number;
}

/** One immutable saved version of a project's JSON. Restoring copies an old doc into a new version. */
@Entity({ name: 'project_versions' })
@Check('project_versions_version_valid', `version >= 1`)
@Check('project_versions_reason_valid', `reason IN ('create', 'save', 'restore', 'restyle', 'template')`)
@Index('project_versions_project_version_key', ['projectId', 'version'], { unique: true })
@Index('project_versions_merchant_id_idx', ['merchantId'])
export class ProjectVersionEntity extends BaseRow {
  @Column({ name: 'merchant_id', type: 'uuid' })
  merchantId!: string;

  @ManyToOne(() => MerchantEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'merchant_id', foreignKeyConstraintName: 'project_versions_merchant_id_fkey' })
  merchant?: MerchantEntity;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId!: string;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'project_id', foreignKeyConstraintName: 'project_versions_project_id_fkey' })
  project?: ProjectEntity;

  @Column({ type: 'integer' })
  version!: number;

  @Column({ type: 'jsonb' })
  doc!: Record<string, unknown>;

  @Column({ type: 'text' })
  reason!: 'create' | 'save' | 'restore' | 'restyle' | 'template';

  @Column({ name: 'restored_from', type: 'integer', nullable: true })
  restoredFrom!: number | null;
}
