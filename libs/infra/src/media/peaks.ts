/** Recipe version of the peaks JSON. */
export const PEAKS_RECIPE = 1;

export type PeaksLevel = { bucketsPerSecond: number; min: number[]; max: number[] };
export type PeaksJson = {
  version: 1;
  durationMs: number;
  /** Values are int8 (-127..127) relative to full scale. */
  levels: PeaksLevel[];
  /** Peak below about -50 dBFS for the whole file. */
  silent: boolean;
  hasAudio: boolean;
};

const BASE_BPS = 100;
const SILENT_PEAK = 0.0032; // ≈ -50 dBFS

/**
 * Streaming min/max reducer for mono s16 PCM (media-pipeline: peaks are computed by streaming, never by loading
 * the file). Level 0 is 100 buckets/s; each next level merges 4 buckets.
 */
export class PeaksBuilder {
  private readonly perBucket: number;
  private mins: number[] = [];
  private maxs: number[] = [];
  private curMin = 32767;
  private curMax = -32768;
  private inBucket = 0;
  private absPeak = 0;
  private carry: number | null = null;

  constructor(sampleRate: number) {
    this.perBucket = sampleRate / BASE_BPS;
  }

  push(samples: Int16Array): void {
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i] ?? 0;
      if (s < this.curMin) this.curMin = s;
      if (s > this.curMax) this.curMax = s;
      const a = s < 0 ? -s : s;
      if (a > this.absPeak) this.absPeak = a;
      if (++this.inBucket >= this.perBucket) this.flush();
    }
  }

  /** Raw little-endian bytes from ffmpeg; chunks may split a sample. */
  pushBytes(chunk: Uint8Array): void {
    let bytes = chunk;
    if (this.carry !== null) {
      const joined = new Uint8Array(chunk.length + 1);
      joined[0] = this.carry;
      joined.set(chunk, 1);
      bytes = joined;
      this.carry = null;
    }
    const even = bytes.length - (bytes.length % 2);
    if (even < bytes.length) this.carry = bytes[bytes.length - 1] ?? 0;
    const view = new DataView(bytes.buffer, bytes.byteOffset, even);
    const samples = new Int16Array(even / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true);
    this.push(samples);
  }

  private flush(): void {
    this.mins.push(this.curMin);
    this.maxs.push(this.curMax);
    this.curMin = 32767;
    this.curMax = -32768;
    this.inBucket = 0;
  }

  finish(durationMs: number): PeaksJson {
    if (this.inBucket > 0) this.flush();
    const want = Math.round((durationMs / 1000) * BASE_BPS);
    while (this.mins.length < want) {
      this.mins.push(0);
      this.maxs.push(0);
    }
    if (this.mins.length > want + 1) {
      this.mins.length = want;
      this.maxs.length = want;
    }
    const q = (v: number) => Math.max(-127, Math.min(127, Math.round((v / 32768) * 127)));
    let min = this.mins.map(q);
    let max = this.maxs.map(q);
    const levels: PeaksLevel[] = [{ bucketsPerSecond: BASE_BPS, min, max }];
    for (let l = 1; l < 4; l++) {
      const nMin: number[] = [];
      const nMax: number[] = [];
      for (let i = 0; i < min.length; i += 4) {
        nMin.push(Math.min(...min.slice(i, i + 4)));
        nMax.push(Math.max(...max.slice(i, i + 4)));
      }
      min = nMin;
      max = nMax;
      levels.push({ bucketsPerSecond: BASE_BPS / 4 ** l, min, max });
    }
    return { version: 1, durationMs, levels, silent: this.absPeak / 32768 < SILENT_PEAK, hasAudio: true };
  }
}

/**
 * Loudness per 100 ms in dBFS from level 0 (max |peak| of 10 buckets, int8 scale), -90 for digital silence — the
 * audio feature of the highlight scorer (E07-F01). Same formula as the test-fixture generator
 * (`libs/domain/src/highlights/fixtures/make-s01-excerpt.py`).
 */
export function loudnessFromPeaks(peaks: PeaksJson): {
  bucketsPerSecond: number;
  startMs: number;
  dbfs: number[];
} {
  const level = peaks.levels[0];
  if (!level || level.bucketsPerSecond !== BASE_BPS) throw new Error('peaks level 0 must be 100 buckets/s');
  const dbfs: number[] = [];
  const n = Math.ceil(level.max.length / 10);
  for (let b = 0; b < n; b++) {
    let peak = 0;
    for (let i = b * 10; i < Math.min(level.max.length, b * 10 + 10); i++) {
      peak = Math.max(peak, Math.abs(level.min[i] ?? 0), Math.abs(level.max[i] ?? 0));
    }
    dbfs.push(peak === 0 ? -90 : Math.round(20 * Math.log10(peak / 127) * 10) / 10);
  }
  return { bucketsPerSecond: 10, startMs: 0, dbfs };
}

/** Peaks for a source without an audio stream: flat, flagged. */
export function noAudioPeaks(durationMs: number): PeaksJson {
  const n = Math.round((durationMs / 1000) * BASE_BPS);
  const levels: PeaksLevel[] = [];
  for (let l = 0; l < 4; l++) {
    const len = Math.ceil(n / 4 ** l);
    levels.push({
      bucketsPerSecond: BASE_BPS / 4 ** l,
      min: new Array(len).fill(0),
      max: new Array(len).fill(0),
    });
  }
  return { version: 1, durationMs, levels, silent: true, hasAudio: false };
}
