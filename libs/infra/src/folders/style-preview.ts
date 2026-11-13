import type { FolderPlanResponse, StylePack } from '@myvideo/contracts';
export function stylePreview(
  pack: StylePack,
  sourceId: string,
  words: readonly { text: string; startMs: number; endMs: number }[],
  productName: string | null,
): NonNullable<FolderPlanResponse['proposals'][number]['preview']> {
  const sample = words.slice(0, 16).map(({ text, startMs, endMs }) => ({ text, startMs, endMs }));
  return {
    sourceId,
    timeMs: sample[0]?.startMs ?? 0,
    words: sample,
    productName,
    captionStyle: pack.captions.styleRef,
    captionY: pack.captions.y,
    maxWords: pack.captions.maxWords,
    maxLines: pack.captions.maxLines,
    hookY: pack.hook.y,
    hookWeight: pack.hook.fontWeight,
    hookColor: pack.hook.color,
    hookBackground: pack.hook.background ?? null,
  };
}
