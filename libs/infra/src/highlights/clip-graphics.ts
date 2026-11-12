import type { LaidOutCaptionPage } from '../render/text-layout.js';

/**
 * Words-driven emphasis and motion-graphic moments (E07-F14, `short-form-editing` skill §3–4). Everything comes from
 * what the seller said or the merchant typed (product name) — nothing is invented.
 */
export type EmphasisPage = Omit<LaidOutCaptionPage, 'words'> & {
  words: (LaidOutCaptionPage['words'][number] & { emphasis?: true })[];
};

const PRICE = /(?:฿\s*\d[\d,.]*|\d[\d,.]*\s*บาท)/u;
const SIZE_VALUE = /^(?:อก|เอว|ยาว|สะโพก|ไหล่|แขน|ไซซ์|ไซส์|ไซต์|size|เบอร์)\s*\S+/iu;
/** Strong selling words worth the accent when nothing more specific is on the page. */
const STRONG = [
  'สีสด',
  'สวย',
  'หมด',
  'ลด',
  'โปร',
  'คุ้ม',
  'ถูก',
  'ใหม่',
  'เด็ด',
  'ปัง',
  'พิเศษ',
  'ฟรี',
  'แถม',
  'ตัวสุดท้าย',
];

/** Marks at most one key word per caption page: price > product > size value > strong selling word. */
export function markEmphasis(
  pages: readonly LaidOutCaptionPage[],
  productTerms: readonly string[],
): EmphasisPage[] {
  const terms = productTerms.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0);
  const rules: ((text: string) => boolean)[] = [
    (t) => PRICE.test(t),
    (t) => terms.some((p) => t.toLowerCase().includes(p)),
    (t) => SIZE_VALUE.test(t),
    (t) => STRONG.some((s) => t.startsWith(s)),
  ];
  return pages.map((p) => {
    let key = -1;
    for (const rule of rules) {
      key = p.words.findIndex((w) => rule(w.text));
      if (key >= 0) break;
    }
    return {
      ...p,
      words: p.words.map((w, i) => (i === key ? { ...w, emphasis: true as const } : { ...w })),
    };
  });
}

/** Spoken prices (verbatim, e.g. "80 บาท") with the project frame where the word starts. */
export function priceMentions(
  pages: readonly LaidOutCaptionPage[],
  opts: { minGapFrames?: number; maxPerClip?: number } = {},
): { text: string; frame: number }[] {
  const out: { text: string; frame: number }[] = [];
  for (const p of pages) {
    for (const w of p.words) {
      const m = PRICE.exec(w.text);
      if (!m) continue;
      const frame = p.startFrame + w.startFrame;
      const last = out[out.length - 1];
      if (last && frame - last.frame < (opts.minGapFrames ?? 0)) continue;
      if (out.length >= (opts.maxPerClip ?? Number.POSITIVE_INFINITY)) return out;
      out.push({ text: m[0].replace(/\s+/gu, ' ').trim(), frame });
    }
  }
  return out;
}
