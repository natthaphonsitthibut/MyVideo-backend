import type { LlmMode, LlmRequest, LlmTier, LlmUsage } from '@myvideo/domain';

/** One raw model call, already turned into plain data. Adapters do no validation and no caching. */
export type AdapterCall = {
  images?: LlmRequest<unknown>['images'];
  signal?: AbortSignal;
  system?: string;
  prompt: string;
  jsonSchema: Record<string, unknown>;
  model: string;
  maxOutputTokens: number;
};

export type AdapterResult = {
  /** The JSON the model returned (not yet validated). */
  output: unknown;
  usage: LlmUsage;
};

/** One adapter per provider or CLI (AGENTS §11): the only place a vendor name or type may appear. */
export interface LlmAdapter {
  readonly mode: Exclude<LlmMode, 'rules'>;
  modelFor(tier: LlmTier): string;
  call(c: AdapterCall): Promise<AdapterResult>;
}

/** Serialises calls: the 8 GB dev machine runs one model call at a time. */
export class OneAtATime {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
