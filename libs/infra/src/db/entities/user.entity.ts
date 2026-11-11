import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseRow } from './base.js';
import { MerchantEntity } from './merchant.entity.js';

@Entity({ name: 'users' })
@Check('users_email_lowercase', `email = lower(email) AND position('@' in email) > 1`)
@Check('users_role_valid', `role IN ('owner', 'editor')`)
export class UserEntity extends BaseRow {
  @Index('users_merchant_id_idx')
  @Column({ name: 'merchant_id', type: 'uuid' })
  merchantId!: string;

  @ManyToOne(() => MerchantEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'merchant_id', foreignKeyConstraintName: 'users_merchant_id_fkey' })
  merchant?: MerchantEntity;

  /** Stored lower-case (CHECK); unique across all merchants so login needs only the email. */
  @Index('users_email_key', { unique: true })
  @Column({ type: 'text' })
  email!: string;

  @Column({ name: 'password_hash', type: 'text' })
  passwordHash!: string;

  @Column({ name: 'display_name', type: 'text' })
  displayName!: string;

  @Column({ type: 'text', default: 'owner' })
  role!: 'owner' | 'editor';
}
