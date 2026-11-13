import { FrozenStyle, type ReferenceGrammar, stylePack } from '@myvideo/contracts';

const median = (a: number[]) => {
  const sorted = [...a].sort((a, b) => a - b);
  return sorted.length % 2
    ? (sorted[Math.floor(sorted.length / 2)] ?? 0)
    : ((sorted[sorted.length / 2 - 1] ?? 0) + (sorted[sorted.length / 2] ?? 0)) / 2;
};
export function measureGrammar(
  durationMs: number,
  cuts: number[],
  colours: string[],
  textSamples: ReferenceGrammar['textSamples'],
  rhythm: ReferenceGrammar['rhythm'],
): ReferenceGrammar {
  const cutsMs = [...new Set([0, ...cuts.filter((c) => c > 0 && c < durationMs), durationMs])].sort(
    (a, b) => a - b,
  );
  return {
    durationMs,
    cutsMs,
    medianShotMs: median(cutsMs.slice(1).map((c, i) => c - (cutsMs[i] ?? 0))),
    colours: colours.slice(0, 6),
    textSamples,
    captionBand: textSamples.length ? median(textSamples.map((s) => s.y)) : null,
    rhythm,
    textSamplePeriodMs: durationMs / 12,
    visionStatus: textSamples.length ? 'measured' : 'not_run',
  };
}
/** Numeric grammar only. Reference copy, frame assets, logos, audio and font files cannot enter this snapshot. */
export function grammarPack(id: string, title: string, g: ReferenceGrammar): FrozenStyle {
  const pack = structuredClone(stylePack('minimal-brand'));
  pack.id = `ref-${id}`;
  pack.name = title;
  pack.description = 'จังหวะและพื้นที่ข้อความที่วัดจากคลิปอ้างอิง ใช้เนื้อหาและไฟล์ของคุณ';
  pack.suits = 'สไตล์อ้างอิงของร้าน';
  pack.energy = g.medianShotMs < 1800 ? 'lively' : g.medianShotMs < 4000 ? 'normal' : 'gentle';
  pack.cuts.maxShotMs = Math.max(1200, Math.min(12000, Math.round(g.medianShotMs)));
  pack.cuts.maxPauseMs = Math.max(220, Math.min(700, Math.round(g.medianShotMs * 0.12)));
  pack.captions.y = (Math.max(0.2, Math.min(0.74, g.captionBand ?? 0.72)) - 0.5) * 1920;
  pack.captions.styleRef = pack.energy === 'lively' ? 'karaoke' : 'anchor';
  pack.captions.maxWords = pack.energy === 'lively' ? 3 : 6;
  pack.zoom = { punchIn: null, punchGap: 0, drift: pack.energy === 'gentle' ? 0.02 : 0.01 };
  pack.sfx = null;
  pack.graphics = { priceTag: null, productName: null, cta: null };
  pack.transitions = null;
  if (g.colours[0]) {
    pack.hook.background = g.colours[0];
    pack.hook.color = contrastText(g.colours[0]);
    if (pack.endCard) {
      pack.endCard.background = g.colours[0];
      pack.endCard.color = pack.hook.color;
    }
  }
  return FrozenStyle.parse({ version: 1, seed: `reference-v1:${id}`, pack });
}
function contrastText(hex: string) {
  const rgb = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return (rgb[0] ?? 0) * 0.2126 + (rgb[1] ?? 0) * 0.7152 + (rgb[2] ?? 0) * 0.0722 > 0.179
    ? '#111111'
    : '#ffffff';
}
