import { z } from 'zod';
import { named } from '../registry.js';
import { DirectorReport } from './director.js';
import { ENERGY_IDS, GRAPHIC_IDS } from './motion.js';

/**
 * Project JSON v1 — the editable timeline (ARCHITECTURE §6). Every time is an integer frame in the project's
 * rational fps; ids are stable UUIDs. Structural rules that span fields (overlaps, references, bounds) live in
 * the pure validator (`validateProject`), not here.
 */
export const PROJECT_SCHEMA_VERSION = 1;

/**
 * Caption looks the stage can draw (`frontend/packages/stage` captions). Adding an id is backwards compatible;
 * removing one needs a migration.
 */
export const CAPTION_STYLE_IDS = [
  'clean',
  'bold-highlight',
  'pop-word',
  'boxed',
  'outline-bold',
  'minimal',
  'anchor',
  'karaoke',
  'keyword-underline',
  'stress-bounce',
  'number-roll',
  'icon-pop',
  'word-stack',
  'sticker',
] as const;
export type CaptionStyleId = (typeof CAPTION_STYLE_IDS)[number];

const frame = z.number().int().min(0);
const frames = z.number().int().min(1);
const id = z.uuid();

export const Fps = named(
  'Fps',
  z.object({ num: z.number().int().min(1).max(240_000), den: z.number().int().min(1).max(1001) }),
  'Rational frame rate, e.g. {num: 30000, den: 1001} = 29.97',
);
export type Fps = z.infer<typeof Fps>;

export const Origin = z.enum(['ai', 'user', 'template']);

export const Transform = named(
  'Transform',
  z.object({
    /** Offset of the element centre from the canvas centre, in canvas pixels. */
    x: z.number(),
    y: z.number(),
    scale: z.number().positive().max(20),
    /** Degrees, clockwise. */
    rotation: z.number().min(-360).max(360),
  }),
);

export const Crop = named(
  'Crop',
  z.object({
    /** Fractions of the source frame (0–1) removed from each side. */
    left: z.number().min(0).max(1),
    top: z.number().min(0).max(1),
    right: z.number().min(0).max(1),
    bottom: z.number().min(0).max(1),
  }),
);

const Keyframe = z.object({
  frame,
  value: z.number(),
  easing: z.enum(['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold']),
});

const common = {
  id,
  trackId: id,
  startFrame: frame,
  durationFrames: frames,
  origin: Origin,
  locked: z.boolean().optional(),
  motion: z
    .object({
      component: z.enum(GRAPHIC_IDS),
      energy: z.enum(ENERGY_IDS),
      evidence: z
        .object({
          kind: z.enum(['merchant', 'transcript', 'chat']),
          quote: z.string().min(1).max(1000),
          sourceId: z.uuid().optional(),
          sourceFrame: frame.optional(),
        })
        .optional(),
    })
    .optional(),
  transition: z
    .object({
      kind: z.enum([
        'hard',
        'match',
        'whip',
        'flash',
        'dip',
        'zoom-punch',
        'slide-push',
        'iris',
        'flood',
        'light-leak',
        'glitch',
      ]),
      motivation: z.string().min(1).max(200),
    })
    .optional(),
  /** Advanced mode only: animated numeric properties (`transform.x`, `opacity` …). */
  keyframes: z.record(z.string().min(1).max(64), z.array(Keyframe).min(1)).optional(),
};

const media = {
  assetId: id,
  /** First frame used from the asset (asset frames, project fps). */
  sourceInFrame: frame,
  playbackRate: z.number().min(0.25).max(4),
  volume: z.number().min(0).max(2),
  fadeInFrames: frame.optional(),
  fadeOutFrames: frame.optional(),
};

const visual = {
  transform: Transform,
  crop: Crop.optional(),
  fit: z.enum(['cover', 'contain', 'fill']),
  opacity: z.number().min(0).max(1).optional(),
};

const Animation = z.object({ presetId: z.string().min(1).max(64), durationFrames: frames });
/** Entrance/exit presets for any visual element (E09-F09). */
const animations = { animationIn: Animation.optional(), animationOut: Animation.optional() };

/** A hex colour, or a brand kit token resolved by the stage from the merchant's current kit (E08-F08). */
const StyleColor = z.string().regex(/^(#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?|brand:(primary|accent|text))$/);

export const TextStyle = named(
  'TextStyle',
  z.object({
    /** A font family, or `brand` = the merchant's brand kit font (E08-F08). */
    fontFamily: z.string().min(1).max(64),
    fontWeight: z.number().int().min(100).max(900),
    /** Canvas pixels. */
    fontSize: z.number().positive().max(1000),
    color: StyleColor,
    background: StyleColor.optional(),
    align: z.enum(['left', 'center', 'right']),
  }),
);

export const VideoElement = z.object({
  type: z.literal('video'),
  ...common,
  ...media,
  ...visual,
  ...animations,
});
export const AudioElement = z.object({ type: z.literal('audio'), ...common, ...media });
export const ImageElement = z.object({
  type: z.literal('image'),
  /** A contained product card over a blurred copy of the same still (no extra video decoder). */
  presentation: z.enum(['plain', 'showcase']).optional(),
  ...common,
  assetId: id,
  ...visual,
  ...animations,
});
export const TextElement = z.object({
  type: z.literal('text'),
  ...common,
  content: z.string().min(1).max(500),
  styleRef: z.string().min(1).max(64).optional(),
  style: TextStyle.optional(),
  transform: Transform,
  opacity: z.number().min(0).max(1).optional(),
  animationIn: Animation.optional(),
  animationOut: Animation.optional(),
});

export const CaptionWord = named(
  'CaptionWord',
  z.object({
    text: z.string().min(1).max(100),
    /** Present only for an AI spelling correction; retain the original token for undo. */
    origin: z.literal('ai').optional(),
    asrText: z.string().min(1).optional(),
    /** The page's key word (price, product, strong benefit): emphasis colour + slightly larger. */
    emphasis: z.literal(true).optional(),
    /** Relative to the caption element's start. */
    startFrame: frame,
    endFrame: frame,
  }),
);

export const CaptionElement = z.object({
  type: z.literal('caption'),
  ...common,
  words: z.array(CaptionWord).min(1),
  /** Stored line breaks: each line lists word indexes in order (the browser never wraps captions). */
  lines: z.array(z.array(z.number().int().min(0)).min(1)).min(1),
  styleRef: z.enum(CAPTION_STYLE_IDS),
  transform: Transform,
  opacity: z.number().min(0).max(1).optional(),
  ...animations,
});

export const ShapeElement = z.object({
  type: z.literal('shape'),
  ...common,
  shape: z.enum(['rect', 'ellipse']),
  /** Canvas pixels. */
  width: z.number().positive(),
  height: z.number().positive(),
  fill: z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/),
  radius: z.number().min(0).optional(),
  transform: Transform,
  opacity: z.number().min(0).max(1).optional(),
  ...animations,
});

export const CtaElement = z.object({
  type: z.literal('cta'),
  ...common,
  label: z.string().min(1).max(80),
  styleRef: z.string().min(1).max(64),
  transform: Transform,
  opacity: z.number().min(0).max(1).optional(),
  ...animations,
});

export const ProjectElement = named(
  'ProjectElement',
  z.discriminatedUnion('type', [
    VideoElement,
    AudioElement,
    ImageElement,
    TextElement,
    CaptionElement,
    ShapeElement,
    CtaElement,
  ]),
);
export type ProjectElement = z.infer<typeof ProjectElement>;
export type ElementType = ProjectElement['type'];

export const TRACK_KINDS = ['video', 'audio', 'caption', 'overlay'] as const;
export const Track = named(
  'Track',
  z.object({
    id,
    kind: z.enum(TRACK_KINDS),
    elementIds: z.array(id),
    /** Advanced timeline (E09): locked = its elements cannot be edited; muted = its audio is silent. */
    locked: z.boolean().optional(),
    muted: z.boolean().optional(),
    music: z.boolean().optional(),
    ducking: z
      .object({
        gainDb: z.number().min(-30).max(0),
        attackFrames: frame,
        releaseFrames: frame,
        speech: z.array(z.object({ startFrame: frame, endFrame: frame })).max(2000),
      })
      .optional(),
  }),
);
export type Track = z.infer<typeof Track>;

export const ProjectAsset = named(
  'ProjectAsset',
  z.object({
    /** A merchant source. Exactly one of `sourceId` / `libraryId` is set (validator). */
    sourceId: id.optional(),
    musicId: id.optional(),
    /** A product library sound (`SOUND_LIBRARY`, D-026): the same for every merchant, never merchant data. */
    libraryId: z
      .string()
      .regex(/^[a-z0-9-]{1,64}$/)
      .optional(),
    /** The merchant's brand kit logo (E08-F08): resolved to the CURRENT logo at preview/render time. */
    brandLogo: z.literal(true).optional(),
    kind: z.enum(['video', 'audio', 'image']),
    /** Length in project frames. */
    durationFrames: frames,
    hasAudio: z.boolean(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  }),
);
export type ProjectAsset = z.infer<typeof ProjectAsset>;

export const Project = named(
  'Project',
  z.object({
    schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
    id,
    merchantId: id,
    fps: Fps,
    width: z.number().int().min(16).max(4096),
    height: z.number().int().min(16).max(4096),
    durationFrames: frames,
    templateRef: z
      .object({ templateId: z.string().min(1), templateVersion: z.number().int().min(1) })
      .optional(),
    brandKitId: id.optional(),
    assets: z.record(id, ProjectAsset),
    tracks: z.array(Track),
    elements: z.record(id, ProjectElement),
    meta: z.object({
      director: DirectorReport.optional(),
      createdBy: z.enum(['ai', 'user']),
      workflowRunId: id.optional(),
      title: z.string().max(200).optional(),
      /** Edit style pack the project was built with (`STYLE_PACKS`); switching style rebuilds from it. */
      styleId: z.string().min(1).max(64).optional(),
    }),
  }),
);
export type Project = z.infer<typeof Project>;
