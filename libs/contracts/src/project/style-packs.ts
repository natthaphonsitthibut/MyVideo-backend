import type { CaptionStyleId } from './schema.js';

/**
 * Edit style packs: how an AI-made clip is cut and dressed. A pack is DATA read by the pure clip builder — the
 * AI decides *what* (the cut, the words, the key moments), the pack decides *how it looks*. Switching packs
 * rebuilds the project from the same plan without calling the AI again. A new style is a new entry here plus,
 * if it needs a new caption look or animation, that look in the stage.
 *
 * Animation preset ids are the stage's (`animationKeyframes`); unknown ids fall back to `fade`.
 */
export type StylePack = {
  id: string;
  /** Shown to the merchant (Thai). */
  name: string;
  description: string;
  captions: { styleRef: CaptionStyleId /** canvas px from centre */; y: number };
  /** Opening title (the hook): shown over the first seconds. */
  hook: {
    seconds: number;
    y: number;
    fontWeight: number;
    color: string;
    background?: string;
    animationIn: string;
  };
  /** Closing card with the clip title (merchant/product text only — never invented claims). Null = none. */
  endCard: { seconds: number; color: string; background: string; animationIn: string } | null;
  /**
   * Jump cuts on the speech: pauses longer than `maxPauseMs` shrink to `keepPauseMs`; filler words go.
   * `maxShotMs`: longer shots are split at word starts into a new framing (no time removed); null = never.
   */
  cuts: { maxPauseMs: number; keepPauseMs: number; removeFillers: boolean; maxShotMs: number | null };
  /**
   * Camera. `cycle`: scale per kept segment, cycled (a new framing at each jump cut hides the cut); `punchIn`: scale
   * for a segment where a price or call to action is spoken; `drift`: slow one-way push-in over each segment
   * (fraction of its scale, linear) so the picture never looks frozen. The camera never zooms back out inside a
   * segment — going wider again only happens at a cut.
   */
  zoom: { cycle: number[]; punchIn: number | null; drift: number };
  /**
   * Sound effects from `SOUND_LIBRARY` (D-026); each starts at (moment − its sync point) so the hit lands on the
   * moment. `cut`: cycled at shot changes, at most one per `minGapMs`; `price` / `cta`: on the shot where a price /
   * call to action is spoken (instead of the cut sound); `hook` / `endCard`: when the opening title / closing card
   * appears. `gainDb` is added to each sound's own under-speech gain. Null = no sound effects.
   */
  sfx: {
    cut: string[];
    minGapMs: number;
    price: string | null;
    cta: string | null;
    hook: string | null;
    endCard: string | null;
    gainDb: number;
  } | null;
};

export const STYLE_PACKS: readonly StylePack[] = [
  {
    id: 'sale-fast',
    name: 'ขายไว ไฟลุก',
    description: 'ตัดช่วงเงียบหมด เปลี่ยนมุมซูมทุกช็อต ซูมแรงตอนพูดราคา ซับคำต่อคำตัวใหญ่',
    captions: { styleRef: 'pop-word', y: 480 },
    hook: {
      seconds: 3,
      y: -560,
      fontWeight: 900,
      color: '#111111',
      background: '#facc15',
      animationIn: 'pop',
    },
    endCard: { seconds: 2, color: '#111111', background: '#facc15', animationIn: 'pop' },
    cuts: { maxPauseMs: 250, keepPauseMs: 80, removeFillers: true, maxShotMs: 3000 },
    zoom: { cycle: [1, 1.12], punchIn: 1.28, drift: 0.045 },
    sfx: {
      cut: ['whoosh-fast-soft', 'swish-soft'],
      minGapMs: 2500,
      price: 'money-register',
      cta: 'pop-medium-in',
      hook: 'pop-medium-in',
      endCard: 'sting-bold-short',
      gainDb: -4,
    },
  },
  {
    id: 'friendly',
    name: 'เป็นกันเอง',
    description: 'ตัดเงียบพอดี ๆ ซูมเบา ๆ ซับในกล่องอ่านง่าย',
    captions: { styleRef: 'boxed', y: 520 },
    hook: {
      seconds: 3,
      y: -520,
      fontWeight: 800,
      color: '#ffffff',
      background: '#000000aa',
      animationIn: 'slide-up',
    },
    endCard: { seconds: 2, color: '#ffffff', background: '#000000cc', animationIn: 'slide-up' },
    cuts: { maxPauseMs: 400, keepPauseMs: 150, removeFillers: true, maxShotMs: 4500 },
    zoom: { cycle: [1, 1.06], punchIn: 1.15, drift: 0.027 },
    sfx: {
      cut: ['whoosh-fast-soft'],
      minGapMs: 4000,
      price: 'shimmer-short-bright',
      cta: 'notification-attention-soft',
      hook: 'pop-small-in',
      endCard: 'sting-warm-short',
      gainDb: -3,
    },
  },
  {
    id: 'premium',
    name: 'เรียบหรู',
    description: 'ตัดนุ่ม ไม่ซูมสลับ ซับตัวบางด้านล่าง เปิด-ปิดแบบค่อย ๆ จาง',
    captions: { styleRef: 'minimal', y: 640 },
    hook: { seconds: 3, y: -480, fontWeight: 500, color: '#ffffff', animationIn: 'fade' },
    endCard: { seconds: 2.5, color: '#f5f0e6', background: '#1c1917', animationIn: 'fade' },
    cuts: { maxPauseMs: 600, keepPauseMs: 250, removeFillers: true, maxShotMs: 7000 },
    zoom: { cycle: [1], punchIn: null, drift: 0.008 },
    sfx: {
      cut: [],
      minGapMs: 0,
      price: null,
      cta: null,
      hook: 'shimmer-short-soft',
      endCard: 'sting-minimal-short',
      gainDb: -6,
    },
  },
  {
    id: 'fun',
    name: 'สนุก มีสีสัน',
    description: 'ตัดเร็ว ซูมเด้งแรง ซับขอบหนาสีจัด',
    captions: { styleRef: 'outline-bold', y: 420 },
    hook: {
      seconds: 2.5,
      y: -560,
      fontWeight: 900,
      color: '#ffffff',
      background: '#ec4899',
      animationIn: 'bounce',
    },
    endCard: { seconds: 2, color: '#ffffff', background: '#7c3aed', animationIn: 'bounce' },
    cuts: { maxPauseMs: 200, keepPauseMs: 60, removeFillers: true, maxShotMs: 2500 },
    zoom: { cycle: [1, 1.15, 1.05], punchIn: 1.35, drift: 0.045 },
    sfx: {
      cut: ['swish-medium', 'whoosh-fast-soft', 'pop-medium-bubble'],
      minGapMs: 1800,
      price: 'money-coin-drop',
      cta: 'pop-large-bubble',
      hook: 'pop-large-bubble',
      endCard: 'sting-playful-short',
      gainDb: -4,
    },
  },
  {
    id: 'simple',
    name: 'มินิมอล',
    description: 'ตัดเฉพาะเงียบนาน ๆ ไม่ซูม ซับเรียบ ไม่มีการ์ดปิด',
    captions: { styleRef: 'clean', y: 560 },
    hook: {
      seconds: 3,
      y: -520,
      fontWeight: 700,
      color: '#ffffff',
      background: '#00000080',
      animationIn: 'fade',
    },
    endCard: null,
    cuts: { maxPauseMs: 800, keepPauseMs: 300, removeFillers: false, maxShotMs: null },
    zoom: { cycle: [1], punchIn: null, drift: 0 },
    sfx: null,
  },
];

export const DEFAULT_STYLE_PACK_ID = 'sale-fast';

export function stylePack(id: string | undefined): StylePack {
  return (
    STYLE_PACKS.find((p) => p.id === id) ??
    (STYLE_PACKS.find((p) => p.id === DEFAULT_STYLE_PACK_ID) as StylePack)
  );
}
