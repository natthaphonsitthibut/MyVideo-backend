export const SOURCE_STATUSES = ['processing', 'ready', 'failed'] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

/** Kinds of files derived from an upload (ARCHITECTURE §8). `original` is immutable. */
export const ASSET_KINDS = ['original', 'proxy', 'audio', 'peaks', 'sprites'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** Accepted upload extensions (real validation is ffprobe in the probe step; this only filters obvious junk). */
export const UPLOAD_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', '3gp', 'mts', 'ts'] as const;

export function extensionOf(filename: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(filename.trim());
  return m?.[1]?.toLowerCase() ?? '';
}
