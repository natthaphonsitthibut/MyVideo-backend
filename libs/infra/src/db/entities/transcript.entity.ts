import {
  type TimedWord,
  TRANSCRIPT_CHUNK_STATUSES,
  TRANSCRIPT_STATUSES,
  type TranscriptChunkStatus,
  type TranscriptStatus,
} from '@myvideo/domain';
import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseRow } from './base.js';
import { MerchantEntity } from './merchant.entity.js';
import { VideoSourceEntity } from './video-source.entity.js';

const list = (xs: readonly string[]) => xs.map((s) => `'${s}'`).join(', ');

/**
 * The ASR transcript of one source's audio. Unique per (source, audio sha256, model, recipe): that tuple is the
 * cache key, so transcribing the same audio again reuses this row. The merged original ASR output is kept in
 * storage (`storage_key`) and never changed; user corrections live in their own layer.
 */
@Entity({ name: 'transcripts' })
@Check('transcripts_status_valid', `status IN (${list(TRANSCRIPT_STATUSES)})`)
@Check('transcripts_chunk_count_valid', `chunk_count >= 0`)
@Index('transcripts_cache_key', ['sourceId', 'audioSha256', 'model', 'recipeVersion'], { unique: true })
@Index('transcripts_merchant_id_idx', ['merchantId'])
export class TranscriptEntity extends BaseRow {
  @Column({ name: 'merchant_id', type: 'uuid' })
  merchantId!: string;

  @ManyToOne(() => MerchantEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'merchant_id', foreignKeyConstraintName: 'transcripts_merchant_id_fkey' })
  merchant?: MerchantEntity;

  @Column({ name: 'source_id', type: 'uuid' })
  sourceId!: string;

  @ManyToOne(() => VideoSourceEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'source_id', foreignKeyConstraintName: 'transcripts_source_id_fkey' })
  source?: VideoSourceEntity;

  @Column({ name: 'audio_sha256', type: 'text' })
  audioSha256!: string;

  @Column({ type: 'text' })
  model!: string;

  @Column({ type: 'text' })
  engine!: string;

  @Column({ name: 'recipe_version', type: 'integer' })
  recipeVersion!: number;

  @Column({ type: 'text', default: 'running' })
  status!: TranscriptStatus;

  @Column({ name: 'duration_ms', type: 'integer' })
  durationMs!: number;

  @Column({ name: 'chunk_count', type: 'integer', default: 0 })
  chunkCount!: number;

  @Column({ type: 'text', nullable: true })
  language!: string | null;

  /** Merged original ASR JSON (immutable once written). */
  @Column({ name: 'storage_key', type: 'text', nullable: true })
  storageKey!: string | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;
}

/** One ASR chunk of a transcript: its span and, once done, its result on the source timeline (resume point). */
@Entity({ name: 'transcript_chunks' })
@Check('transcript_chunks_status_valid', `status IN (${list(TRANSCRIPT_CHUNK_STATUSES)})`)
@Check('transcript_chunks_span_valid', `start_ms >= 0 AND end_ms > start_ms`)
@Index('transcript_chunks_transcript_index_key', ['transcriptId', 'chunkIndex'], { unique: true })
@Index('transcript_chunks_merchant_id_idx', ['merchantId'])
export class TranscriptChunkEntity extends BaseRow {
  @Column({ name: 'merchant_id', type: 'uuid' })
  merchantId!: string;

  @ManyToOne(() => MerchantEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'merchant_id', foreignKeyConstraintName: 'transcript_chunks_merchant_id_fkey' })
  merchant?: MerchantEntity;

  @Column({ name: 'transcript_id', type: 'uuid' })
  transcriptId!: string;

  @ManyToOne(() => TranscriptEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'transcript_id', foreignKeyConstraintName: 'transcript_chunks_transcript_id_fkey' })
  transcript?: TranscriptEntity;

  @Column({ name: 'chunk_index', type: 'integer' })
  chunkIndex!: number;

  @Column({ name: 'start_ms', type: 'integer' })
  startMs!: number;

  @Column({ name: 'end_ms', type: 'integer' })
  endMs!: number;

  @Column({ type: 'text', default: 'pending' })
  status!: TranscriptChunkStatus;

  /** `{ language, model, elapsedMs, segments }` with segment/word times already on the source timeline. */
  @Column({ type: 'jsonb', nullable: true })
  result!: Record<string, unknown> | null;
}

/** One recognised segment of a transcript, with its display words (ms on the source timeline). */
@Entity({ name: 'transcript_segments' })
@Check('transcript_segments_span_valid', `start_ms >= 0 AND end_ms >= start_ms`)
@Index('transcript_segments_transcript_seq_key', ['transcriptId', 'seq'], { unique: true })
@Index('transcript_segments_merchant_id_idx', ['merchantId'])
export class TranscriptSegmentEntity extends BaseRow {
  @Column({ name: 'merchant_id', type: 'uuid' })
  merchantId!: string;

  @ManyToOne(() => MerchantEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'merchant_id', foreignKeyConstraintName: 'transcript_segments_merchant_id_fkey' })
  merchant?: MerchantEntity;

  @Column({ name: 'transcript_id', type: 'uuid' })
  transcriptId!: string;

  @ManyToOne(() => TranscriptEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'transcript_id', foreignKeyConstraintName: 'transcript_segments_transcript_id_fkey' })
  transcript?: TranscriptEntity;

  /** 0-based order in the transcript. */
  @Column({ type: 'integer' })
  seq!: number;

  @Column({ name: 'start_ms', type: 'integer' })
  startMs!: number;

  @Column({ name: 'end_ms', type: 'integer' })
  endMs!: number;

  @Column({ type: 'text' })
  text!: string;

  @Column({ type: 'jsonb', default: [] })
  words!: TimedWord[];

  @Column({ name: 'avg_logprob', type: 'real', nullable: true })
  avgLogprob!: number | null;

  @Column({ name: 'no_speech_prob', type: 'real', nullable: true })
  noSpeechProb!: number | null;
}
