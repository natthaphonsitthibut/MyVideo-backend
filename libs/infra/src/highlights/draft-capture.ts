import type { Project } from '@myvideo/contracts';
import type { StoragePort } from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import { MediaAssetEntity } from '../db/entities/media-asset.entity.js';
import type { StageTextLayout } from '../render/text-layout.js';

export async function captureDraft(
  ds: DataSource,
  storage: StoragePort,
  open: () => Promise<StageTextLayout>,
  p: Project,
  signal?: AbortSignal,
) {
  const handles: { release(): Promise<void> }[] = [],
    media: Record<string, string> = {};
  let layout: StageTextLayout | undefined;
  try {
    for (const e of Object.values(p.elements)) {
      if (e.type !== 'video' && e.type !== 'image') continue;
      if (media[e.assetId]) continue;
      const a = p.assets[e.assetId];
      if (!a?.sourceId) throw new Error('Visual judge requires an owned source image/video');
      const original = await ds
        .getRepository(MediaAssetEntity)
        .findOneBy({ merchantId: p.merchantId, sourceId: a.sourceId, kind: 'original' });
      if (!original) throw new Error('Visual judge source unavailable');
      const file = await storage.localPath(original.storageKey);
      handles.push(file);
      media[e.assetId] = file.path;
    }
    layout = await open();
    return await layout.capture(p, media, signal);
  } finally {
    await layout?.close();
    for (const h of handles) await h.release();
  }
}
