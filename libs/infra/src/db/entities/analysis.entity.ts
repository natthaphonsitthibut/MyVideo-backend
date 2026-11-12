import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseRow } from './base.js';
import { MerchantEntity } from './merchant.entity.js';
import { VideoSourceEntity } from './video-source.entity.js';

export const ANALYSIS_KINDS = ['shots'] as const;
export type AnalysisKind = (typeof ANALYSIS_KINDS)[number];
export const ANALYSIS_STATUSES = ['running', 'ready', 'failed'] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ');

/** One stored part result of a long analysis (resume point). Keyframes are storage keys. */
export type AnalysisPart = {
  index: number;
  startMs: number;
  endMs: number;
  done: boolean;
  shots?: { startMs: number; endMs: number; keyframes: { tMs: number; storageKey: string }[] }[];
  elapsedMs?: number;
};

/**
 * A derived analysis of a source (ARCHITECTURE §4 Source aggregate). Unique per (source, kind, recipe): that is
 * the cache key. Long files are analysed in parts stored in `parts` (resume after a crash re-does only the
 * unfinished parts); the final rows go to `detected_shots`.
 */
@Entity({ name: 'analyses' })
@Check('analyses_kind_valid', `kind IN (${list(ANALYSIS_KINDS)})`)
@Check('analyses_status_valid', `status IN (${list(ANALYSIS_STATUSES)})`)
@Index('analyses_cache_key', ['sourceId', 'kind', 'recipeVersion'], { unique: true })
@Index('analyses_merchant_id_idx', ['merchantId'])
export class AnalysisEntity extends BaseRow {
  @Column({ name: 'merchant_id', type: 'uuid' })
  merchantId!: string;

  @ManyToOne(() => MerchantEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'merchant_id', foreignKeyConstraintName: 'analyses_merchant_id_fkey' })
  merchant?: MerchantEntity;

  @Column({ name: 'source_id', type: 'uuid' })
  sourceId!: string;

  @ManyToOne(() => VideoSourceEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'source_id', foreignKeyConstraintName: 'analyses_source_id_fkey' })
  source?: VideoSourceEntity;

  @Column({ type: 'text' })
  kind!: AnalysisKind;

  @Column({ name: 'recipe_version', type: 'integer' })
  recipeVersion!: number;

  @Column({ type: 'text', nullable: true })
  engine!: string | null;

  @Column({ type: 'text', default: 'running' })
  status!: AnalysisStatus;

  @Column({ type: 'jsonb', default: [] })
  parts!: AnalysisPart[];

  @Column({ type: 'text', nullable: true })
  error!: string | null;
}

/** One detected shot of a source with its 1–3 keyframes (storage keys of JPEGs). */
@Entity({ name: 'detected_shots' })
@Check('detected_shots_span_valid', `start_ms >= 0 AND end_ms > start_ms`)
@Index('detected_shots_analysis_seq_key', ['analysisId', 'seq'], { unique: true })
@Index('detected_shots_merchant_id_idx', ['merchantId'])
export class DetectedShotEntity extends BaseRow {
  @Column({ name: 'merchant_id', type: 'uuid' })
  merchantId!: string;

  @ManyToOne(() => MerchantEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'merchant_id', foreignKeyConstraintName: 'detected_shots_merchant_id_fkey' })
  merchant?: MerchantEntity;

  @Column({ name: 'analysis_id', type: 'uuid' })
  analysisId!: string;

  @ManyToOne(() => AnalysisEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'analysis_id', foreignKeyConstraintName: 'detected_shots_analysis_id_fkey' })
  analysis?: AnalysisEntity;

  @Column({ type: 'integer' })
  seq!: number;

  @Column({ name: 'start_ms', type: 'integer' })
  startMs!: number;

  @Column({ name: 'end_ms', type: 'integer' })
  endMs!: number;

  @Column({ type: 'jsonb', default: [] })
  keyframes!: { tMs: number; storageKey: string }[];
}
