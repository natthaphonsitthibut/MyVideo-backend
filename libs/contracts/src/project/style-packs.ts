import type { Energy } from './motion.js';
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
/**
 * Transitions at jump cuts (E13-F05), drawn with plain editable layers: `flash` = a white frame fading out,
 * `dip` = a short dip to black across the cut, `zoom-punch` = the next shot starts 18 % closer and settles,
 * `slide-push` = the next shot slides in from the side. `flash` and `slide-push` are "loud".
 */
export const TRANSITION_KINDS = [
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
] as const;
export type TransitionKind = (typeof TRANSITION_KINDS)[number];

export type StylePack = {
  id: string;
  energy?: Energy;
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
   * Camera (rules in `segmentShots`, D-037): the base framing most of the time; `punchIn` = tighter framing for the
   * shot where a price or call to action is spoken, at most once per `punchGap` shots and only where the camera
   * rules allow it (jump cut, 2.5 s hold, ≤ 20 % zoomed); `drift` = one slow push-in over each run of shots with
   * the same framing (fraction of its scale) so the picture never looks frozen. There is no per-cut alternating
   * framing any more: it made the picture bounce (user report, measured 2026-11-13).
   */
  zoom: { punchIn: number | null; punchGap: number; drift: number };
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
  /**
   * Transitions on jump cuts, always motivated: `onMoment` on the cut where a price / call to action is said, the
   * other kinds in turn on plain cuts at least `minGapMs` apart. Budget: at most `maxShare` of the cuts (≤ ¼) and
   * at most 2 loud ones per clip. Null = hard cuts only.
   */
  transitions: {
    kinds: readonly TransitionKind[];
    onMoment: TransitionKind | null;
    maxShare: number;
    minGapMs: number;
  } | null;
};

export const STYLE_PACKS: readonly StylePack[] = [
  {
    id: 'sale-fast',
    energy: 'hype',
    name: 'ขายไว ไฟลุก',
    description: 'ตัดกระชับ ซับทีละ 2–3 คำกลางจอ ป้ายราคาเด้งตอนพูดราคา ปิดด้วยปุ่มสั่งซื้อ',
    suits: 'ไลฟ์ขายของที่พูดราคา/โปรบ่อย อยากให้ปิดการขายไว',
    captions: { styleRef: 'stress-bounce', y: 330, maxWords: 3, maxLines: 1 },
    hook: {
      seconds: 2.5,
      y: -560,
      fontWeight: 900,
      color: '#111111',
      background: '#facc15',
      animationIn: 'pop',
    },
    endCard: { seconds: 2.5, color: '#ffffff', background: '#111111e6', animationIn: 'pop' },
    cuts: { maxPauseMs: 300, keepPauseMs: 100, removeFillers: true, removeRestarts: true, maxShotMs: 2500 },
    zoom: { punchIn: 1.2, punchGap: 3, drift: 0.012 },
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
    transitions: { kinds: ['zoom-punch'], onMoment: 'flash', maxShare: 0.25, minGapMs: 3000 },
  },
  {
    id: 'friendly',
    energy: 'normal',
    name: 'เล่าเป็นกันเอง',
    description: 'จังหวะพูดธรรมชาติ ซับในกล่องทีละประโยคสั้น ชื่อสินค้าขึ้นมุมล่าง ไม่หวือหวา',
    suits: 'รีวิว/เล่าเรื่องสินค้า พูดช้า ๆ อธิบายรายละเอียด',
    captions: { styleRef: 'karaoke', y: 520, maxWords: 5, maxLines: 1 },
    hook: {
      seconds: 3,
      y: -520,
      fontWeight: 800,
      color: '#ffffff',
      background: '#000000aa',
      animationIn: 'slide-up',
    },
    endCard: { seconds: 2.5, color: '#ffffff', background: '#000000cc', animationIn: 'slide-up' },
    cuts: { maxPauseMs: 450, keepPauseMs: 150, removeFillers: true, removeRestarts: true, maxShotMs: 3500 },
    zoom: { punchIn: 1.12, punchGap: 4, drift: 0.008 },
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
    transitions: null,
  },
  {
    id: 'premium',
    energy: 'calm',
    name: 'เรียบหรู',
    description: 'ภาพนิ่งนาน ค่อย ๆ ดันกล้องช้า ๆ ซับบางด้านล่าง ไม่มีป้ายเด้ง เปิด–ปิดแบบจาง',
    suits: 'สินค้าราคาสูง/แบรนด์ อยากให้ดูแพง สงบ',
    captions: { styleRef: 'anchor', y: 640, maxWords: 6, maxLines: 1 },
    hook: { seconds: 3, y: -480, fontWeight: 500, color: '#ffffff', animationIn: 'fade' },
    endCard: { seconds: 3, color: '#f5f0e6', background: '#1c1917e6', animationIn: 'fade' },
    cuts: { maxPauseMs: 650, keepPauseMs: 250, removeFillers: true, removeRestarts: true, maxShotMs: null },
    // one long shot is normal here: a slow, steady push keeps it alive (long monologue → push 100 → ~105 %)
    zoom: { punchIn: null, punchGap: 0, drift: 0.05 },
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
    transitions: { kinds: ['dip', 'light-leak'], onMoment: null, maxShare: 0.15, minGapMs: 6000 },
  },
  {
    id: 'fun',
    energy: 'lively',
    name: 'สนุก มีสีสัน',
    description: 'ตัดเร็ว ซับทีละ 1–2 คำตัวใหญ่ ซูมเน้นบ่อยขึ้น ป้ายราคาเด้งสีจัด',
    suits: 'คนขายพลังเยอะ พูดเร็ว สินค้าแฟชั่น/ของเล่น/ขนม',
    captions: { styleRef: 'icon-pop', y: 380, maxWords: 2, maxLines: 1 },
    hook: {
      seconds: 2.5,
      y: -560,
      fontWeight: 900,
      color: '#ffffff',
      background: '#ec4899',
      animationIn: 'bounce',
    },
    endCard: { seconds: 2.5, color: '#ffffff', background: '#7c3aede6', animationIn: 'bounce' },
    cuts: { maxPauseMs: 220, keepPauseMs: 60, removeFillers: true, removeRestarts: true, maxShotMs: 2500 },
    zoom: { punchIn: 1.22, punchGap: 2, drift: 0.015 },
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
    transitions: {
      kinds: ['whip', 'iris', 'glitch'],
      onMoment: 'zoom-punch',
      maxShare: 0.25,
      minGapMs: 2000,
    },
  },
  {
    id: 'simple',
    energy: 'gentle',
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
    zoom: { punchIn: null, punchGap: 0, drift: 0 },
    graphics: { priceTag: null, productName: null, cta: null },
    sfx: null,
    transitions: null,
  },
  // ---- E13-F08: seven more packs (our own design for Thai online selling) ----
  {
    id: 'live-hype',
    energy: 'hype',
    name: 'แม่ค้าไลฟ์ไฟลุก',
    description: 'ตัดถี่มาก ซับทีละ 2 คำ ซูมเน้นทุกจังหวะราคา แฟลชตอนบอกราคา สไลด์ภาพเปลี่ยนช็อต',
    suits: 'ไลฟ์ขายของพลังสูง พูดเร็ว บอกราคาบ่อย อยากได้คลิปเร้าใจ',
    captions: { styleRef: 'word-stack', y: 360, maxWords: 2, maxLines: 2 },
    hook: {
      seconds: 2,
      y: -580,
      fontWeight: 900,
      color: '#ffffff',
      background: '#dc2626',
      animationIn: 'pop',
    },
    endCard: { seconds: 2, color: '#ffffff', background: '#dc2626e6', animationIn: 'pop' },
    cuts: { maxPauseMs: 180, keepPauseMs: 50, removeFillers: true, removeRestarts: true, maxShotMs: 2500 },
    zoom: { punchIn: 1.25, punchGap: 2, drift: 0.015 },
    graphics: {
      priceTag: { color: '#ffffff', background: '#dc2626', animationIn: 'pop', y: 60, maxPerClip: 3 },
      productName: null,
      cta: { label: 'กดตะกร้าด่วน!', animationIn: 'pop', y: 170 },
    },
    sfx: {
      cut: ['whoosh-fast-soft'],
      minGapMs: 5000,
      price: 'money-coin-drop',
      maxPrice: 3,
      cta: 'pop-large-bubble',
      hook: 'sting-bold-short',
      endCard: 'sting-bright-short',
      gainDb: -3,
    },
    transitions: { kinds: ['whip', 'iris', 'glitch'], onMoment: 'flash', maxShare: 0.25, minGapMs: 2000 },
  },
  {
    id: 'honest-review',
    energy: 'gentle',
    name: 'รีวิวจริงใจ',
    description: 'จังหวะคนเล่าจริง เก็บช่วงหายใจไว้นิดหน่อย ซับกล่องล่างทีละประโยค ราคาขึ้นเรียบ ๆ ไม่มีเอฟเฟกต์ตัด',
    suits: 'รีวิวใช้จริง เล่าข้อดีข้อเสีย อยากให้คนดูเชื่อใจ',
    captions: { styleRef: 'keyword-underline', y: 600, maxWords: 6, maxLines: 1 },
    hook: {
      seconds: 3,
      y: -500,
      fontWeight: 700,
      color: '#111111',
      background: '#ffffffee',
      animationIn: 'fade',
    },
    endCard: { seconds: 2.5, color: '#111111', background: '#ffffffee', animationIn: 'fade' },
    cuts: { maxPauseMs: 550, keepPauseMs: 200, removeFillers: true, removeRestarts: true, maxShotMs: 4000 },
    zoom: { punchIn: 1.1, punchGap: 2, drift: 0.01 },
    graphics: {
      priceTag: { color: '#111111', background: '#ffffffee', animationIn: 'fade', y: 140, maxPerClip: 1 },
      productName: { color: '#111111', background: '#ffffffd9', animationIn: 'fade', y: -330 },
      cta: null,
    },
    sfx: null,
    transitions: { kinds: ['dip', 'light-leak'], onMoment: null, maxShare: 0.1, minGapMs: 8000 },
  },
  {
    id: 'gadget-spec',
    energy: 'normal',
    name: 'สเปกแกดเจ็ต',
    description: 'ภาพคม ตัดเงียบสั้น ซูมเข้าตอนบอกสเปก/ราคา ภาพสไลด์เปลี่ยนช็อต เสียงฟึ่บเบา ๆ ป้ายราคาโทนเทคโนโลยี',
    suits: 'มือถือ หูฟัง อุปกรณ์ไอที โชว์ฟีเจอร์ทีละข้อ',
    captions: { styleRef: 'number-roll', y: 520, maxWords: 4, maxLines: 1 },
    hook: {
      seconds: 2.5,
      y: -540,
      fontWeight: 800,
      color: '#22d3ee',
      background: '#0f172ae6',
      animationIn: 'zoom-in',
    },
    endCard: { seconds: 2.5, color: '#e0f2fe', background: '#0f172ae6', animationIn: 'zoom-in' },
    cuts: { maxPauseMs: 280, keepPauseMs: 90, removeFillers: true, removeRestarts: true, maxShotMs: 3000 },
    zoom: { punchIn: 1.18, punchGap: 3, drift: 0.01 },
    graphics: {
      priceTag: { color: '#0f172a', background: '#22d3ee', animationIn: 'zoom-in', y: 100, maxPerClip: 2 },
      productName: { color: '#e0f2fe', background: '#0f172acc', animationIn: 'slide-up', y: -330 },
      cta: { label: 'ดูสเปกเต็มที่ตะกร้า', animationIn: 'zoom-in', y: 170 },
    },
    sfx: {
      cut: ['swish-soft'],
      minGapMs: 6000,
      price: 'notification-success-sparkle',
      maxPrice: 2,
      cta: 'notification-success-ding-ding',
      hook: 'whoosh-fast-soft',
      endCard: 'sting-minimal-short',
      gainDb: -6,
    },
    transitions: { kinds: ['slide-push'], onMoment: 'zoom-punch', maxShare: 0.2, minGapMs: 3000 },
  },
  {
    id: 'skincare-premium',
    energy: 'calm',
    name: 'พรีเมียมสกินแคร์',
    description: 'ช้า นุ่ม ภาพค่อย ๆ ดันเข้า ซับบางสีอ่อน จางเข้า–ออกระหว่างช็อต ไม่มีป้ายเด้ง',
    suits: 'เครื่องสำอาง สกินแคร์ น้ำหอม อยากให้ดูหรูแต่อบอุ่น',
    captions: { styleRef: 'anchor', y: 620, maxWords: 5, maxLines: 1 },
    hook: { seconds: 3, y: -480, fontWeight: 500, color: '#fff1f2', animationIn: 'fade' },
    endCard: { seconds: 3, color: '#fff1f2', background: '#4c0519d9', animationIn: 'fade' },
    cuts: { maxPauseMs: 700, keepPauseMs: 260, removeFillers: true, removeRestarts: true, maxShotMs: null },
    zoom: { punchIn: null, punchGap: 0, drift: 0.045 },
    graphics: {
      priceTag: null,
      productName: { color: '#fff1f2', background: '#4c0519b3', animationIn: 'fade', y: -330 },
      cta: null,
    },
    sfx: {
      cut: [],
      minGapMs: 0,
      price: null,
      maxPrice: 0,
      cta: null,
      hook: 'shimmer-short-soft',
      endCard: 'shimmer-short-bright',
      gainDb: -9,
    },
    transitions: { kinds: ['dip', 'light-leak'], onMoment: null, maxShare: 0.2, minGapMs: 5000 },
  },
  {
    id: 'cute-sticker',
    energy: 'lively',
    name: 'น่ารักสติกเกอร์',
    description: 'ซับตัวหนาขอบชมพูทีละ 1–2 คำ ทุกอย่างเด้งดึ๋ง ซูมเน้นตอนพูดราคา เสียงป๊อปฟองสบู่',
    suits: 'ของน่ารัก ของเล่น เครื่องเขียน กิ๊ฟช็อป กลุ่มลูกค้าวัยรุ่น',
    captions: { styleRef: 'sticker', y: 420, maxWords: 2, maxLines: 1 },
    hook: {
      seconds: 2.5,
      y: -560,
      fontWeight: 900,
      color: '#ffffff',
      background: '#f472b6',
      animationIn: 'bounce',
    },
    endCard: { seconds: 2.5, color: '#ffffff', background: '#f472b6e6', animationIn: 'bounce' },
    cuts: { maxPauseMs: 250, keepPauseMs: 80, removeFillers: true, removeRestarts: true, maxShotMs: 2500 },
    zoom: { punchIn: 1.15, punchGap: 2, drift: 0.01 },
    graphics: {
      priceTag: { color: '#ffffff', background: '#a855f7', animationIn: 'bounce', y: 90, maxPerClip: 2 },
      productName: { color: '#ffffff', background: '#f472b6cc', animationIn: 'bounce', y: -330 },
      cta: { label: 'กดตะกร้าเลยน้า', animationIn: 'bounce', y: 170 },
    },
    sfx: {
      cut: ['pop-medium-bubble'],
      minGapMs: 5000,
      price: 'pop-large-bubble',
      maxPrice: 2,
      cta: 'pop-medium-bubble',
      hook: 'pop-large-bubble',
      endCard: 'sting-playful-short',
      gainDb: -5,
    },
    transitions: { kinds: ['zoom-punch'], onMoment: 'zoom-punch', maxShare: 0.25, minGapMs: 2500 },
  },
  {
    id: 'flash-sale',
    energy: 'hype',
    name: 'แฟลชเซล',
    description: 'จังหวะเร็ว ป้ายราคาแดงเด้งใหญ่ แฟลชตอนบอกราคา ซับไฮไลต์คำสำคัญ ปิดด้วยปุ่มสั่งซื้อ',
    suits: 'โปรลดราคา ของแถม วันเซล อยากให้รีบตัดสินใจ (ใช้ราคาที่พูดจริงเท่านั้น)',
    captions: { styleRef: 'number-roll', y: 400, maxWords: 3, maxLines: 1 },
    hook: {
      seconds: 2,
      y: -560,
      fontWeight: 900,
      color: '#facc15',
      background: '#991b1bf2',
      animationIn: 'zoom-in',
    },
    endCard: { seconds: 2.5, color: '#facc15', background: '#991b1bf2', animationIn: 'zoom-in' },
    cuts: { maxPauseMs: 220, keepPauseMs: 70, removeFillers: true, removeRestarts: true, maxShotMs: 2500 },
    zoom: { punchIn: 1.22, punchGap: 2, drift: 0.012 },
    graphics: {
      priceTag: { color: '#facc15', background: '#991b1b', animationIn: 'zoom-in', y: 40, maxPerClip: 3 },
      productName: null,
      cta: { label: 'กดสั่งเลยก่อนหมดโปร', animationIn: 'zoom-in', y: 170 },
    },
    sfx: {
      cut: [],
      minGapMs: 0,
      price: 'money-register',
      maxPrice: 3,
      cta: 'notification-attention-soft',
      hook: 'sting-bold-short',
      endCard: 'sting-bold-short',
      gainDb: -3,
    },
    transitions: { kinds: ['zoom-punch'], onMoment: 'flash', maxShare: 0.25, minGapMs: 2500 },
  },
  {
    id: 'minimal-brand',
    energy: 'gentle',
    name: 'มินิมอลแบรนด์',
    description: 'สะอาด เว้นจังหวะ ไม่ซูมแรง ซับบรรทัดเดียวล่างจอ จางดำระหว่างช่วง ปิดด้วยชื่อสินค้า',
    suits: 'แบรนด์เสื้อผ้า ของแต่งบ้าน สินค้าที่ภาพสวยอยู่แล้ว',
    captions: { styleRef: 'anchor', y: 680, maxWords: 6, maxLines: 1 },
    hook: { seconds: 3, y: -500, fontWeight: 600, color: '#ffffff', animationIn: 'fade' },
    endCard: { seconds: 2.5, color: '#ffffff', background: '#000000cc', animationIn: 'fade' },
    cuts: { maxPauseMs: 600, keepPauseMs: 220, removeFillers: true, removeRestarts: true, maxShotMs: null },
    zoom: { punchIn: null, punchGap: 0, drift: 0.02 },
    graphics: {
      priceTag: null,
      productName: { color: '#ffffff', background: '#00000099', animationIn: 'fade', y: -330 },
      cta: null,
    },
    sfx: {
      cut: [],
      minGapMs: 0,
      price: null,
      maxPrice: 0,
      cta: null,
      hook: null,
      endCard: 'sting-minimal-short',
      gainDb: -8,
    },
    transitions: { kinds: ['dip', 'light-leak'], onMoment: null, maxShare: 0.15, minGapMs: 6000 },
  },
];

export const DEFAULT_STYLE_PACK_ID = 'sale-fast';

export function stylePack(id: string | undefined): StylePack {
  return (
    STYLE_PACKS.find((p) => p.id === id) ??
    (STYLE_PACKS.find((p) => p.id === DEFAULT_STYLE_PACK_ID) as StylePack)
  );
}
