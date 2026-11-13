import { z } from 'zod';
import { CAPTION_STYLE_IDS } from './schema.js';
import { type StylePack, TRANSITION_KINDS } from './style-packs.js';

const Color = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);
const Graphic = z.object({ color: Color, background: Color, animationIn: z.string(), y: z.number() });
/** Full recipe frozen by the server, not an ID that can change when the catalogue is updated. */
export const StylePackSnapshot: z.ZodType<StylePack> = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  suits: z.string(),
  captions: z.object({
    styleRef: z.enum(CAPTION_STYLE_IDS),
    y: z.number(),
    maxWords: z.number().int().positive().nullable(),
    maxLines: z.number().int().positive(),
  }),
  hook: z.object({
    seconds: z.number().positive(),
    y: z.number(),
    fontWeight: z.number(),
    color: Color,
    background: Color.optional(),
    animationIn: z.string(),
  }),
  endCard: z
    .object({ seconds: z.number().positive(), color: Color, background: Color, animationIn: z.string() })
    .nullable(),
  cuts: z.object({
    maxPauseMs: z.number().nonnegative(),
    keepPauseMs: z.number().nonnegative(),
    removeFillers: z.boolean(),
    removeRestarts: z.boolean(),
    maxShotMs: z.number().positive().nullable(),
  }),
  zoom: z.object({
    punchIn: z.number().positive().nullable(),
    punchGap: z.number().int().nonnegative(),
    drift: z.number().nonnegative(),
  }),
  graphics: z.object({
    priceTag: Graphic.extend({ maxPerClip: z.number().int().nonnegative() }).nullable(),
    productName: Graphic.nullable(),
    cta: z.object({ label: z.string(), animationIn: z.string(), y: z.number() }).nullable(),
  }),
  sfx: z
    .object({
      cut: z.array(z.string()),
      minGapMs: z.number().nonnegative(),
      price: z.string().nullable(),
      maxPrice: z.number().int().nonnegative(),
      cta: z.string().nullable(),
      hook: z.string().nullable(),
      endCard: z.string().nullable(),
      gainDb: z.number(),
    })
    .nullable(),
  transitions: z
    .object({
      kinds: z.array(z.enum(TRANSITION_KINDS)),
      onMoment: z.enum(TRANSITION_KINDS).nullable(),
      maxShare: z.number().min(0).max(0.25),
      minGapMs: z.number().nonnegative(),
    })
    .nullable(),
});
export const FrozenStyle = z.object({
  version: z.literal(1),
  seed: z.string().min(1),
  pack: StylePackSnapshot,
});
export type FrozenStyle = z.infer<typeof FrozenStyle>;
