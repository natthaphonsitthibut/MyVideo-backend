import type { SpanMs } from '@myvideo/domain';
import { z } from 'zod';
import type { ClipPlan, OutputRatio } from './clip-project.js';

/**
 * The inputs `clips.build` gave the pure project builder, stored on the clip suggestion. Everything that needed an
 * AI call (corrected caption words, hook, title) is frozen here, so a restyle rebuilds the clip with another style
 * pack from exactly the same words and cuts without calling the AI again (ARCHITECTURE guardrail 4).
 */
const Word = z.object({
  text: z.string(),
  startMs: z.number().int(),
  endMs: z.number().int(),
  origin: z.literal('ai').optional(),
  asrText: z.string().optional(),
});
const Span = z.object({ startMs: z.number().int(), endMs: z.number().int() });

const ClipBuildInputSchema = z.object({
  version: z.literal(1),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(1),
  words: z.array(Word),
  /** VAD speech spans inside the clip (source ms): the jump cuts of a style follow the real pauses. */
  speech: z.array(Span),
  title: z.string(),
  hook: z.object({ text: z.string(), origin: z.enum(['ai', 'rules']) }).nullable(),
  /** What the merchant typed as the product name (graphics, emphasis); absent when none. */
  productName: z.string().optional(),
  /** Output frame (E12-F09); absent = 9:16 (clips built before ratios existed). */
  ratio: z.enum(['9:16', '4:5', '1:1', '16:9']).optional(),
  /** Measured face centre across the clip (0..1 of the source width), for side crops. */
  faceX: z.number().min(0).max(1).optional(),
  photos: z
    .array(
      z.object({
        sourceId: z.uuid(),
        kind: z.literal('image'),
        width: z.number().positive(),
        height: z.number().positive(),
        durationFrames: z.number().int().positive(),
      }),
    )
    .optional(),
});
export type ClipBuildInput = z.infer<typeof ClipBuildInputSchema>;

export function clipBuildInput(input: {
  plan: ClipPlan;
  speech: readonly SpanMs[];
  productName?: string;
  ratio?: OutputRatio;
  faceX?: number;
  photos?: ClipBuildInput['photos'];
}): ClipBuildInput {
  const { plan } = input;
  return {
    version: 1,
    startMs: plan.startMs,
    endMs: plan.endMs,
    words: plan.words.map((w) => ({ ...w })),
    speech: input.speech.map((s) => ({ startMs: s.startMs, endMs: s.endMs })),
    title: plan.title,
    hook: plan.hook ? { text: plan.hook.text, origin: plan.hook.origin } : null,
    ...(input.productName?.trim() ? { productName: input.productName.trim() } : {}),
    ...(input.ratio && input.ratio !== '9:16' ? { ratio: input.ratio } : {}),
    ...(input.faceX !== undefined ? { faceX: input.faceX } : {}),
    ...(input.photos?.length ? { photos: input.photos.map((p) => ({ ...p })) } : {}),
  };
}

/** Stored input → the builder's plan; null when absent (older clips) or not in the current shape. */
export function parseClipBuildInput(raw: unknown): ClipBuildInput | null {
  const r = ClipBuildInputSchema.safeParse(raw);
  return r.success ? r.data : null;
}

export function planOf(input: ClipBuildInput): ClipPlan {
  return {
    startMs: input.startMs,
    endMs: input.endMs,
    words: input.words,
    title: input.title,
    ...(input.hook ? { hook: input.hook } : {}),
  };
}
