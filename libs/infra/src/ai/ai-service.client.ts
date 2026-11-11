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
