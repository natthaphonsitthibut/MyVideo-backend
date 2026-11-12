/** A span of the source timeline in integer milliseconds (audio side; Project JSON uses frames). */
export type SpanMs = { startMs: number; endMs: number };

/** One ASR chunk: a contiguous piece of the source audio sent to the recogniser on its own. */
export type ChunkSpan = SpanMs & { index: number };

export type TimedWord = SpanMs & { text: string; kind: string };
export type TimedSegment = SpanMs & { text: string; words: TimedWord[] };

/** Chunks are at most 10 minutes (E04 plan): long enough for context, short enough to resume cheaply. */
export const MAX_CHUNK_MS = 10 * 60_000;
/** Silence kept before speech when a chunk starts after a long silent stretch. */
const LEAD_IN_MS = 1000;

/**
 * Cuts a recording into ASR chunks from its VAD speech segments (ARCHITECTURE §9):
 * - a cut lands in the middle of the silence before the segment that would overflow `maxMs`;
 * - a speech run longer than `maxMs` without any silence is hard-cut at `maxMs`;
 * - long silent stretches are skipped, so every chunk contains speech (no speech at all → no chunks);
 * - chunks are ≤ `maxMs`, ordered, non-overlapping; consecutive chunks touch unless silence was skipped.
 */
export function planChunks(
  speech: readonly SpanMs[],
  durationMs: number,
  opts: { maxMs?: number } = {},
): ChunkSpan[] {
  const maxMs = opts.maxMs ?? MAX_CHUNK_MS;
  const segs = speech
    .map((s) => ({ startMs: Math.max(0, s.startMs), endMs: Math.min(durationMs, s.endMs) }))
    .filter((s) => s.endMs > s.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  if (segs.length === 0) return [];

  const chunks: ChunkSpan[] = [];
  const emit = (startMs: number, endMs: number) => chunks.push({ index: chunks.length, startMs, endMs });
  let chunkStart = 0;
  /** End of the last speech already inside the current chunk; null = none yet. */
  let lastEnd: number | null = null;

  for (const s of segs) {
    while (s.endMs - chunkStart > maxMs) {
      if (lastEnd !== null) {
        // cut in the middle of the silence between the chunk's last speech and this segment
        const cut = Math.min(Math.round((lastEnd + Math.max(lastEnd, s.startMs)) / 2), chunkStart + maxMs);
        emit(chunkStart, cut);
        chunkStart = cut;
        lastEnd = null;
      } else if (s.startMs > chunkStart + LEAD_IN_MS) {
        // nothing said since the last cut: skip the silence
        chunkStart = s.startMs - LEAD_IN_MS;
      } else {
        emit(chunkStart, chunkStart + maxMs);
        chunkStart += maxMs;
      }
    }
    lastEnd = Math.max(lastEnd ?? 0, s.endMs);
  }
  emit(chunkStart, Math.min(durationMs, chunkStart + maxMs));
  return chunks;
}

/**
 * Moves one chunk's recogniser output (times relative to the chunk file) onto the source timeline. Times are
 * clamped to the chunk so neighbouring chunks never overlap; segments starting after the chunk are dropped.
 */
export function offsetChunkSegments(segments: readonly TimedSegment[], chunk: ChunkSpan): TimedSegment[] {
  const len = chunk.endMs - chunk.startMs;
  const at = (ms: number) => chunk.startMs + Math.max(0, Math.min(len, ms));
  return segments
    .filter((s) => s.startMs < len)
    .map((s) => ({
      ...s,
      startMs: at(s.startMs),
      endMs: at(s.endMs),
      words: s.words.map((w) => ({ ...w, startMs: at(w.startMs), endMs: at(w.endMs) })),
    }));
}
