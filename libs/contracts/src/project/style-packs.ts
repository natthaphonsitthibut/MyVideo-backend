import type { CaptionStyleId } from './schema.js';

/**
 * Edit style packs: how an AI-made clip is cut and dressed. A pack is DATA read by the pure clip builder — the
 * AI decides *what* (the cut, the words, the key moments), the pack decides *how it is edited*. Packs must differ
 * in editing, not only in looks: pace (pauses, restarts, shot length), words per caption page, caption position,
 * emphasis, re-framing rule, motion graphics, hook format and sound density (user review 2026-11-12: "เปลี่ยนแค่
 * ฟอนต์ สี"). Every effect is tied to what is said (a price, a call to action), never to a timer.
 *
 * Animation preset ids are the stage's (`animationKeyframes`); unknown ids fall back to `fade`.
 */
export type StylePack = {
  id: string;
  /** Shown to the merchant (Thai). */
  name: string;
  description: string;
  /** What kind of seller video it suits (Thai) — shown with the AI's style recommendation. */
  suits: string;
  /**
   * `y`: canvas px from centre. `maxWords`: phrases per caption page on `maxLines` lines (short-form pages, balanced,
   * a number never split from its unit); null = classic fill of `maxLines` lines.
   */
  captions: { styleRef: CaptionStyleId; y: number; maxWords: number | null; maxLines: number };
  /** Opening title (the hook): on the first frame, over the first seconds. */
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
   * Jump cuts on the speech: pauses longer than `maxPauseMs` shrink to `keepPauseMs`; filler words go; restarts
   * (a phrase said again) keep only the later take. `maxShotMs`: a longer continuous shot gets one re-frame at a
   * word start (no time removed); null = never.
   */
  cuts: {
    maxPauseMs: number;
    keepPauseMs: number;
    removeFillers: boolean;
    removeRestarts: boolean;
    maxShotMs: number | null;
  };
  /**
   * Camera. `cycle`: framing per shot, alternated at cuts (a light change hides a jump cut); `punchIn`: tighter
   * framing for the shot where a price or call to action is spoken, at most once per `punchGap` shots; `drift`:
   * slow one-way push-in over each shot (fraction of its scale) so the picture never looks frozen.
   */
  zoom: { cycle: number[]; punchIn: number | null; punchGap: number; drift: number };
  /**
   * Motion graphics, each tied to the words: `priceTag` pops up with a spoken price (the seller's own words, at most
   * `maxPerClip`); `productName` = the merchant's product name as a lower-third after the hook; `cta` = a call-to-
   * action pill over the closing seconds. Null = not in this style.
   */
  graphics: {
    priceTag: {
      color: string;
      background: string;
      animationIn: string;
      y: number;
      maxPerClip: number;
    } | null;
    productName: { color: string; background: string; animationIn: string; y: number } | null;
    cta: { label: string; animationIn: string; y: number } | null;
  };
  /**
   * Sound effects from `SOUND_LIBRARY` (D-026) mark moments, they do not decorate cuts: `hook` / `endCard` when the
   * title / closing card appears, `price` / `cta` on those shots (`price` at most `maxPrice` per clip), `cut` only in
   * energetic styles and at most one per `minGapMs`. `gainDb` is added to each sound's under-speech gain.
   */
  sfx: {
    cut: string[];
    minGapMs: number;
    price: string | null;
    maxPrice: number;
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
    description: 'ตัดกระชับ ซับทีละ 2–3 คำกลางจอ ป้ายราคาเด้งตอนพูดราคา ปิดด้วยปุ่มสั่งซื้อ',
    suits: 'ไลฟ์ขายของที่พูดราคา/โปรบ่อย อยากให้ปิดการขายไว',
    captions: { styleRef: 'pop-word', y: 330, maxWords: 3, maxLines: 1 },
    hook: {
      seconds: 2.5,
      y: -560,
      fontWeight: 900,
      color: '#111111',
      background: '#facc15',
      animationIn: 'pop',
    },
    endCard: { seconds: 2.5, color: '#ffffff', background: '#111111e6', animationIn: 'pop' },
    cuts: { maxPauseMs: 300, keepPauseMs: 100, removeFillers: true, removeRestarts: true, maxShotMs: 4500 },
    zoom: { cycle: [1, 1.08], punchIn: 1.2, punchGap: 3, drift: 0.012 },
    graphics: {
      priceTag: { color: '#111111', background: '#facc15', animationIn: 'pop', y: 80, maxPerClip: 2 },
      productName: { color: '#ffffff', background: '#111111cc', animationIn: 'slide-up', y: -330 },
      cta: { label: 'กดตะกร้า สั่งได้เลย', animationIn: 'pop', y: 170 },
    },
    sfx: {
      cut: [],
      minGapMs: 0,
      price: 'money-register',
      maxPrice: 2,
      cta: 'pop-medium-in',
      hook: 'pop-medium-in',
      endCard: 'sting-bold-short',
      gainDb: -4,
    },
  },
  {
    id: 'friendly',
    name: 'เล่าเป็นกันเอง',
    description: 'จังหวะพูดธรรมชาติ ซับในกล่องทีละประโยคสั้น ชื่อสินค้าขึ้นมุมล่าง ไม่หวือหวา',
    suits: 'รีวิว/เล่าเรื่องสินค้า พูดช้า ๆ อธิบายรายละเอียด',
    captions: { styleRef: 'boxed', y: 520, maxWords: 5, maxLines: 1 },
    hook: {
      seconds: 3,
      y: -520,
      fontWeight: 800,
      color: '#ffffff',
      background: '#000000aa',
      animationIn: 'slide-up',
    },
    endCard: { seconds: 2.5, color: '#ffffff', background: '#000000cc', animationIn: 'slide-up' },
    cuts: { maxPauseMs: 450, keepPauseMs: 150, removeFillers: true, removeRestarts: true, maxShotMs: 6500 },
    zoom: { cycle: [1, 1.05], punchIn: 1.12, punchGap: 4, drift: 0.008 },
    graphics: {
      priceTag: { color: '#111111', background: '#ffffffee', animationIn: 'slide-up', y: 120, maxPerClip: 1 },
      productName: { color: '#ffffff', background: '#000000aa', animationIn: 'slide-up', y: -330 },
      cta: { label: 'สนใจ ทักแชทได้เลย', animationIn: 'slide-up', y: 170 },
    },
    sfx: {
      cut: [],
      minGapMs: 0,
      price: 'shimmer-short-bright',
      maxPrice: 1,
      cta: null,
      hook: 'pop-small-in',
      endCard: 'sting-warm-short',
      gainDb: -6,
    },
  },
  {
    id: 'premium',
    name: 'เรียบหรู',
    description: 'ภาพนิ่งนาน ค่อย ๆ ดันกล้องช้า ๆ ซับบางด้านล่าง ไม่มีป้ายเด้ง เปิด–ปิดแบบจาง',
    suits: 'สินค้าราคาสูง/แบรนด์ อยากให้ดูแพง สงบ',
    captions: { styleRef: 'minimal', y: 640, maxWords: 6, maxLines: 1 },
    hook: { seconds: 3, y: -480, fontWeight: 500, color: '#ffffff', animationIn: 'fade' },
    endCard: { seconds: 3, color: '#f5f0e6', background: '#1c1917e6', animationIn: 'fade' },
    cuts: { maxPauseMs: 650, keepPauseMs: 250, removeFillers: true, removeRestarts: true, maxShotMs: null },
    // one long shot is normal here: a slow, steady push keeps it alive (long monologue → push 100 → ~105 %)
    zoom: { cycle: [1], punchIn: null, punchGap: 0, drift: 0.05 },
    graphics: {
      priceTag: null,
      productName: { color: '#f5f0e6', background: '#1c1917b3', animationIn: 'fade', y: -330 },
      cta: null,
    },
    sfx: {
      cut: [],
      minGapMs: 0,
      price: null,
      maxPrice: 0,
      cta: null,
      hook: 'shimmer-short-soft',
      endCard: 'sting-minimal-short',
      gainDb: -8,
    },
  },
  {
    id: 'fun',
    name: 'สนุก มีสีสัน',
    description: 'ตัดเร็ว ซับทีละ 1–2 คำตัวใหญ่ ซูมเน้นบ่อยขึ้น ป้ายราคาเด้งสีจัด',
    suits: 'คนขายพลังเยอะ พูดเร็ว สินค้าแฟชั่น/ของเล่น/ขนม',
    captions: { styleRef: 'outline-bold', y: 380, maxWords: 2, maxLines: 1 },
    hook: {
      seconds: 2.5,
      y: -560,
      fontWeight: 900,
      color: '#ffffff',
      background: '#ec4899',
      animationIn: 'bounce',
    },
    endCard: { seconds: 2.5, color: '#ffffff', background: '#7c3aede6', animationIn: 'bounce' },
    cuts: { maxPauseMs: 220, keepPauseMs: 60, removeFillers: true, removeRestarts: true, maxShotMs: 3500 },
    zoom: { cycle: [1, 1.1], punchIn: 1.22, punchGap: 2, drift: 0.015 },
    graphics: {
      priceTag: { color: '#ffffff', background: '#ec4899', animationIn: 'bounce', y: 100, maxPerClip: 2 },
      productName: null,
      cta: { label: 'กดตะกร้าเลย!', animationIn: 'bounce', y: 170 },
    },
    sfx: {
      cut: ['swish-medium'],
      minGapMs: 6000,
      price: 'money-coin-drop',
      maxPrice: 2,
      cta: 'pop-large-bubble',
      hook: 'pop-large-bubble',
      endCard: 'sting-playful-short',
      gainDb: -4,
    },
  },
  {
    id: 'simple',
    name: 'มินิมอล',
    description: 'ตัดเฉพาะเงียบนาน ๆ ไม่ซูม ไม่มีกราฟิก/เสียงเพิ่ม ซับเรียบ 2 บรรทัด',
    suits: 'อยากได้คลิปดิบ ๆ เป็นธรรมชาติ ไปแต่งต่อเอง',
    captions: { styleRef: 'clean', y: 560, maxWords: null, maxLines: 2 },
    hook: {
      seconds: 3,
      y: -520,
      fontWeight: 700,
      color: '#ffffff',
      background: '#00000080',
      animationIn: 'fade',
    },
    endCard: null,
    cuts: { maxPauseMs: 800, keepPauseMs: 300, removeFillers: false, removeRestarts: false, maxShotMs: null },
    zoom: { cycle: [1], punchIn: null, punchGap: 0, drift: 0 },
    graphics: { priceTag: null, productName: null, cta: null },
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
