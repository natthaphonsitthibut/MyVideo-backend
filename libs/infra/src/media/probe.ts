import { runProcess } from '../process/run-process.js';

export type Rational = { num: number; den: number };

export type ProbeInfo = {
  container: string;
  durationMs: number;
  sizeBytes: number | null;
  orientation: 'portrait' | 'landscape' | 'square';
  video: {
    codec: string;
    /** Display size (after rotation). */
    width: number;
    height: number;
    codedWidth: number;
    codedHeight: number;
    rotation: 0 | 90 | 180 | 270;
    /** Frame rate the project will use (VFR sources are normalised to 30 fps). */
    fps: Rational;
    /** The stream's own average rate. */
    avgFps: Rational;
    vfr: boolean;
    durationFrames: number;
    pixFmt: string;
    bitDepth: number;
    hdr: boolean;
  };
  audio: { codec: string; sampleRate: number; channels: number } | null;
};

export type ProbeRejection = {
  ok: false;
  reason: 'unreadable' | 'no_video' | 'too_short' | 'too_long' | 'too_large' | 'truncated';
  /** Shown to the merchant. */
  messageTh: string;
};

export type ProbeOutcome = { ok: true; info: ProbeInfo } | ProbeRejection;

const MESSAGES: Record<ProbeRejection['reason'], string> = {
  unreadable: 'เปิดไฟล์นี้ไม่ได้ ไฟล์อาจเสียหรือไม่ใช่ไฟล์วิดีโอ ลองอัปโหลดไฟล์ต้นฉบับอีกครั้ง',
  no_video: 'ไฟล์นี้มีแต่เสียง ไม่มีภาพวิดีโอ',
  too_short: 'วิดีโอสั้นเกินไป (ต้องยาวอย่างน้อย 1 วินาที)',
  too_long: 'วิดีโอยาวเกิน 4 ชั่วโมง กรุณาตัดเป็นช่วงก่อนอัปโหลด',
  too_large: 'ความละเอียดสูงเกิน 4K ยังไม่รองรับ',
  truncated: 'ไฟล์วิดีโอไม่ครบ (อัปโหลดไม่สมบูรณ์หรือไฟล์เสีย) ลองอัปโหลดใหม่อีกครั้ง',
};

const reject = (reason: ProbeRejection['reason']): ProbeRejection => ({
  ok: false,
  reason,
  messageTh: MESSAGES[reason],
});

const MAX_SECONDS = 4 * 3600;
const MAX_PIXELS = 4096 * 2304;
const DEFAULT_FPS: Rational = { num: 30, den: 1 };

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

export function parseRational(s: unknown): Rational | null {
  if (typeof s !== 'string') return null;
  const [n, d] = s.split('/').map(Number);
  if (!n || !d || !Number.isFinite(n) || !Number.isFinite(d) || n <= 0 || d <= 0) return null;
  const g = gcd(n, d);
  return { num: n / g, den: d / g };
}

const value = (r: Rational) => r.num / r.den;

type FfStream = Record<string, unknown> & { codec_type?: string };
type FfProbe = { format?: Record<string, unknown>; streams?: FfStream[] } | null;

function rotationOf(s: FfStream): 0 | 90 | 180 | 270 {
  const side = (s.side_data_list as { rotation?: number }[] | undefined)?.find(
    (d) => typeof d.rotation === 'number',
  );
  const tag = Number((s.tags as Record<string, string> | undefined)?.rotate ?? Number.NaN);
  const raw = side?.rotation ?? (Number.isFinite(tag) ? tag : 0);
  const norm = (((Math.round(raw / 90) * 90) % 360) + 360) % 360;
  return norm as 0 | 90 | 180 | 270;
}

/**
 * Pure: ffprobe JSON (with `-count_packets`) → normalised metadata or a rejection with a Thai message
 * (media-pipeline rule 3: probe first, trust nothing). Time is converted to integer frames here, at the edge.
 */
export function normalizeProbe(raw: FfProbe, sizeBytes: number | null = null): ProbeOutcome {
  const streams = raw?.streams ?? [];
  const format = raw?.format ?? {};
  if (streams.length === 0) return reject('unreadable');
  const v = streams.find(
    (s) =>
      s.codec_type === 'video' && (s.disposition as Record<string, number> | undefined)?.attached_pic !== 1,
  );
  if (!v) return streams.some((s) => s.codec_type === 'audio') ? reject('no_video') : reject('unreadable');
  const a = streams.find((s) => s.codec_type === 'audio');

  const duration = Number(format.duration ?? v.duration ?? 0);
  if (!Number.isFinite(duration) || duration <= 0) return reject('unreadable');
  if (duration < 1) return reject('too_short');
  if (duration > MAX_SECONDS) return reject('too_long');

  const codedWidth = Number(v.width ?? 0);
  const codedHeight = Number(v.height ?? 0);
  if (!codedWidth || !codedHeight) return reject('unreadable');
  if (codedWidth * codedHeight > MAX_PIXELS) return reject('too_large');

  const rFps = parseRational(v.r_frame_rate);
  const avgFps = parseRational(v.avg_frame_rate) ?? rFps;
  if (!avgFps) return reject('unreadable');
  // VFR: the stream's average differs from its nominal rate by more than 1 %.
  const vfr = !!rFps && Math.abs(value(rFps) - value(avgFps)) / value(rFps) > 0.01;
  const fps = vfr || !rFps || value(rFps) > 120 ? DEFAULT_FPS : rFps;

  // Truncation: far fewer packets can be read than the header promises (moov at the front, data cut off).
  const readPackets = Number(v.nb_read_packets ?? Number.NaN);
  const expected = Number(v.nb_frames ?? Number.NaN) || duration * value(avgFps);
  if (
    Number.isFinite(readPackets) &&
    Number.isFinite(expected) &&
    expected > 10 &&
    readPackets < expected * 0.9
  ) {
    return reject('truncated');
  }

  const rotation = rotationOf(v);
  const swap = rotation === 90 || rotation === 270;
  const width = swap ? codedHeight : codedWidth;
  const height = swap ? codedWidth : codedHeight;
  const pixFmt = String(v.pix_fmt ?? '');
  const bitDepth = Number(v.bits_per_raw_sample ?? /(10|12)(le|be)?$/.exec(pixFmt)?.[1] ?? 8);
  const transfer = String(v.color_transfer ?? '');
  return {
    ok: true,
    info: {
      container: String(format.format_name ?? ''),
      durationMs: Math.round(duration * 1000),
      sizeBytes: sizeBytes ?? (format.size ? Number(format.size) : null),
      orientation: width === height ? 'square' : height > width ? 'portrait' : 'landscape',
      video: {
        codec: String(v.codec_name ?? ''),
        width,
        height,
        codedWidth,
        codedHeight,
        rotation,
        fps,
        avgFps,
        vfr,
        durationFrames: Math.round((duration * fps.num) / fps.den),
        pixFmt,
        bitDepth: Number.isFinite(bitDepth) ? bitDepth : 8,
        hdr: transfer === 'smpte2084' || transfer === 'arib-std-b67',
      },
      audio: a
        ? {
            codec: String(a.codec_name ?? ''),
            sampleRate: Number(a.sample_rate ?? 0),
            channels: Number(a.channels ?? 0),
          }
        : null,
    },
  };
}

/** Runs ffprobe (argument array, timeout, cancellable) and normalises the result. */
export async function probeFile(
  path: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ProbeOutcome> {
  let out = '';
  try {
    await runProcess(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-count_packets', path],
      { signal: opts.signal, timeoutMs: opts.timeoutMs ?? 120_000, onStdoutLine: (l) => (out += `${l}\n`) },
    );
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    return reject('unreadable');
  }
  try {
    return normalizeProbe(JSON.parse(out));
  } catch {
    return reject('unreadable');
  }
}
