import { z } from 'zod';
import { named } from '../registry.js';
import { CAPTION_STYLE_IDS } from './schema.js';

/**
 * Review-to-Video templates (E10, ARCHITECTURE §10). A template version is DATA read by the pure template engine:
 * ordered slots (what kind of shot goes where, how long), caption look and text roles. Text is only ever the
 * merchant's own words (product name, the points they typed, their brand call-to-action) or what they said on camera
 * — a template never invents claims. Published versions are immutable: `templates.lock.json` holds a hash per
 * version and a test fails when a published version changes (bump `version` instead). Projects keep the version they
 * were built with (`templateRef`).
 */
export const SHOT_ROLES = ['talking_head', 'product_closeup', 'demo', 'unboxing', 'broll'] as const;
export type ShotRole = (typeof SHOT_ROLES)[number];

/** Thai names shown to the merchant ("ยังขาดช็อตนี้" guidance and the role picker). */
export const SHOT_ROLE_NAMES: Record<ShotRole, string> = {
  talking_head: 'พูดหน้ากล้อง',
  product_closeup: 'ภาพสินค้าใกล้ ๆ',
  demo: 'สาธิตการใช้งาน',
  unboxing: 'แกะกล่อง',
  broll: 'ภาพประกอบ',
};

/** What to shoot when a slot has no footage (Thai, shown to the merchant). */
export const SHOT_ROLE_HINTS: Record<ShotRole, string> = {
  talking_head: 'ถ่ายตัวเองพูดถึงสินค้า 5–15 วินาที หันหน้าเข้ากล้อง',
  product_closeup: 'ถ่ายสินค้าใกล้ ๆ ช้า ๆ 3–6 วินาที ให้เห็นรายละเอียด',
  demo: 'ถ่ายตอนใช้สินค้าจริง 4–10 วินาที',
  unboxing: 'ถ่ายตอนเปิดกล่อง/แกะห่อ 4–10 วินาที',
  broll: 'ถ่ายบรรยากาศหรือสินค้าวางในที่ใช้งาน 3–6 วินาที',
};

export const TemplateSlot = z.object({
  /** Shot roles this slot takes, best first. */
  accepts: z.array(z.enum(SHOT_ROLES)).min(1),
  required: z.boolean(),
  minMs: z.number().int().min(500),
  maxMs: z.number().int().min(500),
  /** On-screen text over this slot: the product name, one of the merchant's points, or none. */
  text: z.enum(['product_name', 'point', 'none']),
});
export type TemplateSlot = z.infer<typeof TemplateSlot>;

export const TemplateVersion = named(
  'TemplateVersion',
  z.object({
    id: z.string().regex(/^[a-z0-9-]{1,40}$/),
    version: z.number().int().min(1),
    /** Thai, shown in the picker. */
    name: z.string().min(1).max(40),
    description: z.string().min(1).max(200),
    /** Total length the result should land in. */
    durationMs: z.object({ min: z.number().int().min(1000), max: z.number().int().min(1000) }),
    slots: z.array(TemplateSlot).min(1).max(12),
    captions: z.object({ styleRef: z.enum(CAPTION_STYLE_IDS), y: z.number() }),
    /** Opening title (product name) and closing call-to-action, coloured by brand kit tokens. */
    title: z.object({ y: z.number(), seconds: z.number().min(1).max(6), animationIn: z.string() }),
    cta: z.object({ seconds: z.number().min(1).max(6), y: z.number(), animationIn: z.string() }),
    /** Entrance of the merchant's point labels. */
    pointAnimationIn: z.string(),
  }),
);
export type TemplateVersion = z.infer<typeof TemplateVersion>;

const s = (
  accepts: ShotRole[],
  required: boolean,
  minMs: number,
  maxMs: number,
  text: TemplateSlot['text'],
) => ({
  accepts,
  required,
  minMs,
  maxMs,
  text,
});

/** Every published version (append new versions; never edit a published one). */
export const TEMPLATE_VERSIONS: readonly TemplateVersion[] = [
  {
    id: 'review',
    version: 1,
    name: 'รีวิวสินค้า',
    description: 'คนขายพูดถึงสินค้า สลับกับภาพสินค้าและการใช้งานจริง ปิดด้วยปุ่มชวนซื้อ',
    durationMs: { min: 12_000, max: 45_000 },
    slots: [
      s(['talking_head'], true, 2_500, 8_000, 'product_name'),
      s(['product_closeup', 'unboxing', 'broll'], true, 2_000, 5_000, 'point'),
      s(['demo', 'product_closeup'], false, 3_000, 8_000, 'point'),
      s(['talking_head'], false, 3_000, 12_000, 'none'),
      s(['product_closeup', 'broll', 'demo'], false, 2_000, 4_000, 'point'),
    ],
    captions: { styleRef: 'bold-highlight', y: 420 },
    title: { y: -560, seconds: 2.5, animationIn: 'pop' },
    cta: { seconds: 2.5, y: 300, animationIn: 'bounce' },
    pointAnimationIn: 'slide-up',
  },
  {
    id: 'unboxing',
    version: 1,
    name: 'แกะกล่อง',
    description: 'เปิดกล่องให้เห็นของจริง ตามด้วยภาพสินค้าใกล้ ๆ และการใช้งาน',
    durationMs: { min: 10_000, max: 40_000 },
    slots: [
      s(['unboxing'], true, 3_000, 10_000, 'product_name'),
      s(['product_closeup'], true, 2_000, 5_000, 'point'),
      s(['demo', 'product_closeup', 'broll'], false, 3_000, 8_000, 'point'),
      s(['talking_head'], false, 2_500, 10_000, 'none'),
      s(['product_closeup', 'broll'], false, 2_000, 4_000, 'point'),
    ],
    captions: { styleRef: 'pop-word', y: 420 },
    title: { y: -560, seconds: 2.5, animationIn: 'zoom-in' },
    cta: { seconds: 2.5, y: 300, animationIn: 'pop' },
    pointAnimationIn: 'pop',
  },
  {
    id: 'showcase',
    version: 1,
    name: 'โชว์สินค้า',
    description: 'ภาพสินค้าล้วน ไม่ต้องพูด ตัดเร็ว ใส่จุดเด่นที่คุณพิมพ์เอง',
    durationMs: { min: 8_000, max: 30_000 },
    slots: [
      s(['product_closeup', 'broll', 'unboxing'], true, 2_000, 4_000, 'product_name'),
      s(['product_closeup', 'demo', 'broll'], true, 2_000, 4_000, 'point'),
      s(['demo', 'product_closeup', 'broll'], false, 2_000, 4_000, 'point'),
      s(['product_closeup', 'broll', 'demo'], false, 2_000, 4_000, 'point'),
      s(['broll', 'product_closeup', 'demo', 'unboxing'], false, 2_000, 4_000, 'none'),
    ],
    captions: { styleRef: 'clean', y: 420 },
    title: { y: -560, seconds: 2.5, animationIn: 'slide-up' },
    cta: { seconds: 2.5, y: 300, animationIn: 'fade' },
    pointAnimationIn: 'fade',
  },
];

/** Newest version of each template (what the picker offers). */
export function latestTemplates(): TemplateVersion[] {
  const out = new Map<string, TemplateVersion>();
  for (const t of TEMPLATE_VERSIONS) {
    const cur = out.get(t.id);
    if (!cur || cur.version < t.version) out.set(t.id, t);
  }
  return [...out.values()];
}

export function templateVersion(id: string, version?: number): TemplateVersion | undefined {
  if (version === undefined) return latestTemplates().find((t) => t.id === id);
  return TEMPLATE_VERSIONS.find((t) => t.id === id && t.version === version);
}
