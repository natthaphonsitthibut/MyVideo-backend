import { z } from 'zod';
import type { ProbeResult } from '../health/probes.js';

/** The AI service could not be reached (refused, DNS, timeout). Retryable. */
export class AiServiceUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AiServiceUnavailableError';
  }
}

/** The AI service answered with an error status or an unexpected body. Retryable only for 5xx. */
export class AiServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AiServiceError';
  }
}

export const AiHealth = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
  python: z.string(),
});
export type AiHealth = z.infer<typeof AiHealth>;

export const VadResult = z.object({
  segments: z.array(z.object({ start_ms: z.number().int(), end_ms: z.number().int() })),
  speech_ms: z.number().int(),
  model: z.string(),
});
export type VadResult = z.infer<typeof VadResult>;

export const ShotsResult = z.object({
  engine: z.string(),
  recipe: z.number().int(),
  fps: z.number(),
  cuts_ms: z.array(z.number().int()),
  shots: z.array(
    z.object({
      start_ms: z.number().int(),
      end_ms: z.number().int(),
      keyframes: z.array(z.object({ t_ms: z.number().int(), path: z.string() })),
    }),
  ),
  elapsed_ms: z.number().int(),
});
export type ShotsResult = z.infer<typeof ShotsResult>;

export const FacesResult = z.object({
  engine: z.string(),
  images: z.array(
    z.object({
      path: z.string(),
      faces: z.number().int(),
      largest_ratio: z.number(),
      // centre of the largest face (0..1 of the frame); null without a face, absent from older services
      center_x: z.number().nullable().optional(),
      center_y: z.number().nullable().optional(),
    }),
  ),
});
export type FacesResult = z.infer<typeof FacesResult>;

export const AsrResult = z.object({
  language: z.string(),
  duration_ms: z.number().int(),
  segments: z.array(
    z.object({
      start_ms: z.number().int(),
      end_ms: z.number().int(),
      text: z.string(),
      /** Display words (pythainlp), timings spread over the segment. */
      words: z.array(
        z.object({
          text: z.string(),
          start_ms: z.number().int(),
          end_ms: z.number().int(),
          kind: z.string(),
        }),
      ),
      avg_logprob: z.number().nullable(),
      no_speech_prob: z.number().nullable(),
    }),
  ),
  model: z.string(),
  engine: z.string(),
  elapsed_ms: z.number().int(),
});
export type AsrResult = z.infer<typeof AsrResult>;

export const AsrInfo = z.object({
  engine: z.string(),
  model: z.string(),
  language: z.string(),
  flags: z.string(),
});
export type AsrInfo = z.infer<typeof AsrInfo>;

export type AiServiceClientOptions = { baseUrl: string; timeoutMs?: number };

/** Typed HTTP client for `services/ai`. Every call has a timeout; errors map to the two classes above. */
export class AiServiceClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: AiServiceClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async request<T extends z.ZodType>(
    path: string,
    schema: T,
    init: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<z.infer<T>> {
    const timeout = AbortSignal.timeout(init.timeoutMs ?? this.timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal,
      });
    } catch (err) {
      if (init.signal?.aborted) throw err;
      const reason = timeout.aborted
        ? `timed out after ${init.timeoutMs ?? this.timeoutMs} ms`
        : 'unreachable';
      throw new AiServiceUnavailableError(`AI service ${reason}: ${path}`, { cause: err });
    }
    const text = await res.text();
    if (!res.ok) {
      throw new AiServiceError(
        `AI service ${res.status} on ${path}: ${text.slice(0, 300)}`,
        res.status,
        res.status >= 500,
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AiServiceError(`AI service returned non-JSON on ${path}`, res.status, false);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new AiServiceError(
        `AI service response for ${path} failed validation: ${parsed.error.message}`,
        res.status,
        false,
      );
    }
    return parsed.data;
  }

  /** Shots (and optional 1–3 JPEG keyframes each) of a local video file, optionally within a time range. */
  shots(
    path: string,
    opts: { startMs?: number; endMs?: number; keyframesDir?: string; signal?: AbortSignal } = {},
  ): Promise<ShotsResult> {
    return this.request('/shots', ShotsResult, {
      method: 'POST',
      body: { path, start_ms: opts.startMs, end_ms: opts.endMs, keyframes_dir: opts.keyframesDir },
      timeoutMs: 30 * 60_000,
      signal: opts.signal,
    });
  }

  /** Face presence per local keyframe image (YuNet): count and largest face / frame area. */
  faces(paths: string[], opts: { signal?: AbortSignal } = {}): Promise<FacesResult> {
    return this.request('/faces', FacesResult, {
      method: 'POST',
      body: { paths },
      timeoutMs: 5 * 60_000,
      signal: opts.signal,
    });
  }

  /** Speech segments (ms) of a local audio file (Silero VAD). */
  vad(
    path: string,
    opts: { minSilenceMs?: number; speechPadMs?: number; signal?: AbortSignal } = {},
  ): Promise<VadResult> {
    return this.request('/vad', VadResult, {
      method: 'POST',
      body: {
        path,
        min_silence_ms: opts.minSilenceMs ?? 300,
        ...(opts.speechPadMs !== undefined ? { speech_pad_ms: opts.speechPadMs } : {}),
      },
      timeoutMs: 10 * 60_000,
      signal: opts.signal,
    });
  }

  /** Transcribes one local audio chunk. 409 (busy) is retryable: the service runs one chunk at a time. */
  asr(path: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<AsrResult> {
    return this.request('/asr', AsrResult, {
      method: 'POST',
      body: { path },
      timeoutMs: opts.timeoutMs ?? 30 * 60_000,
      signal: opts.signal,
    });
  }

  /** Which engine/model `/asr` runs (does not load the model). Used in the transcript cache key. */
  asrInfo(opts: { signal?: AbortSignal } = {}): Promise<AsrInfo> {
    return this.request('/asr/info', AsrInfo, { signal: opts.signal });
  }

  health(timeoutMs = 2000): Promise<AiHealth> {
    return this.request('/health', AiHealth, { timeoutMs });
  }

  /** Never throws: for /health aggregation. */
  async probe(timeoutMs = 2000): Promise<ProbeResult> {
    const started = performance.now();
    try {
      await this.health(timeoutMs);
      return { status: 'up', latencyMs: Math.round(performance.now() - started) };
    } catch (err) {
      return {
        status: 'down',
        latencyMs: Math.round(performance.now() - started),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
