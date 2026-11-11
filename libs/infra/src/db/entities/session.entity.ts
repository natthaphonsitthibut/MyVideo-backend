import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { MerchantEntity } from './merchant.entity.js';
import { UserEntity } from './user.entity.js';

/** Login session. The cookie holds a random token; only its SHA-256 is stored, so a DB leak is not a login. */
@Entity({ name: 'sessions' })
export class SessionEntity {
  @PrimaryColumn({ type: 'uuid', default: () => 'uuidv7()' })
  id!: string;

  @Index('sessions_token_hash_key', { unique: true })
  @Column({ name: 'token_hash', type: 'bytea' })
  tokenHash!: Buffer;

  @Index('sessions_user_id_idx')
  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'sessions_user_id_fkey' })
  user?: UserEntity;

  @Index('sessions_merchant_id_idx')
  @Column({ name: 'merchant_id', type: 'uuid' })
  merchantId!: string;

  @ManyToOne(() => MerchantEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'merchant_id', foreignKeyConstraintName: 'sessions_merchant_id_fkey' })
  merchant?: MerchantEntity;

  @Index('sessions_expires_at_idx')
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
