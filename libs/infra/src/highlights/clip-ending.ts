/** A clip ending on the last syllable feels cut off: keep a short breath of the silence after it. */
export const TAIL_MS = 600;
const GUARD_MS = 60;

export function clipEndWithTail(
  endMs: number,
  nextWordStartMs: number | undefined,
  durationMs: number,
): number {
  const limit = Math.min(durationMs, nextWordStartMs === undefined ? durationMs : nextWordStartMs - GUARD_MS);
  return Math.max(endMs, Math.min(endMs + TAIL_MS, limit));
}

/**
 * One spelling for the Thai size word in everything the AI writes (titles, hooks, end card, captions): ไซซ์ (the
 * Royal Institute spelling, merchant's choice 2026-11-12) instead of ไซส์ / ไซต์ / ไซ้ส์ before a size letter.
 * "เว็บไซต์" (website) is left alone.
 */
export function normalizeThaiSpelling(text: string): string {
  return text
    .normalize('NFC')
    .replace(/(?<!เว็บ)(?:ไซส์|ไซ้ส์|ไซ้ซ์)/gu, 'ไซซ์')
    .replace(/(?<!เว็บ)ไซต์(?=\s*(?:XXL|XL|XS|[SML]|2XL|3XL|ฟรี)\b)/gu, 'ไซซ์');
}
