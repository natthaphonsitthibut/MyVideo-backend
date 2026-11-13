export const OUTPUT_RATIOS = ['9:16', '4:5', '1:1', '16:9'] as const;
export type OutputRatioId = (typeof OUTPUT_RATIOS)[number];

/**
 * "Auto" output frame = the majority orientation of the footage (videos and photos alike); ties and an empty set go
 * to 9:16, the frame of the short-video platforms merchants post to. Within 5 % of square counts as square.
 * The project page shows the same rule (frontend `auto-ratio.ts`, same tests).
 */
export function autoOutputRatio(
  footage: readonly { width: number | null | undefined; height: number | null | undefined }[],
): '9:16' | '16:9' | '1:1' {
  const count = { '9:16': 0, '16:9': 0, '1:1': 0 };
  for (const f of footage) {
    if (!f.width || !f.height) continue;
    const r = f.width / f.height;
    if (Math.abs(r - 1) <= 0.05) count['1:1']++;
    else if (r < 1) count['9:16']++;
    else count['16:9']++;
  }
  const order = ['9:16', '16:9', '1:1'] as const;
  return order.reduce<(typeof order)[number]>((best, k) => (count[k] > count[best] ? k : best), '9:16');
}

/** The folder setting → the frame to edit for. */
export function resolveOutputRatio(
  setting: string | undefined,
  footage: readonly { width: number | null | undefined; height: number | null | undefined }[],
): OutputRatioId {
  return (OUTPUT_RATIOS as readonly string[]).includes(setting ?? '')
    ? (setting as OutputRatioId)
    : autoOutputRatio(footage);
}
