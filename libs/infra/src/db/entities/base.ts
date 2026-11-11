import { CreateDateColumn, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Columns every table has: UUIDv7 id (Postgres 18 `uuidv7()`), timestamps (ARCHITECTURE §4). */
export abstract class BaseRow {
  @PrimaryColumn({ type: 'uuid', default: () => 'uuidv7()' })
  id!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
