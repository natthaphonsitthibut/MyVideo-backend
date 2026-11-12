import type { FolderRecord } from '@myvideo/contracts';
import { uuidv7 } from '@myvideo/domain';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

@Injectable()
export class FoldersService {
  constructor(@Inject(DataSource) private readonly ds: DataSource) {}

  async get(merchantId: string, id: string, em: DataSource | EntityManager = this.ds): Promise<FolderRecord> {
    const rows: { id: string; title: string; updated_at: Date }[] = await em.query(
      'SELECT id,title,updated_at FROM project_folders WHERE id=$1 AND merchant_id=$2',
      [id, merchantId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundException('Project folder not found');
    const sources: { source_id: string }[] = await em.query(
      'SELECT source_id FROM project_folder_sources WHERE folder_id=$1 AND merchant_id=$2 ORDER BY created_at,id',
      [id, merchantId],
    );
    // Clips remain editable timelines. Membership follows their footage, including clips built after upload.
    const clips: { id: string }[] = sources.length
      ? await em.query(
          `SELECT p.id FROM projects p JOIN project_versions v ON v.project_id=p.id AND v.version=p.current_version AND v.merchant_id=$2
      WHERE p.merchant_id=$2 AND EXISTS (
        SELECT 1 FROM jsonb_each(v.doc->'assets') a JOIN project_folder_sources fs
          ON fs.source_id::text=a.value->>'sourceId' AND fs.folder_id=$1 AND fs.merchant_id=$2
      ) ORDER BY p.updated_at DESC,p.id`,
          [id, merchantId],
        )
      : [];
    return {
      id: row.id,
      title: row.title,
      updatedAt: new Date(row.updated_at).toISOString(),
      sourceIds: sources.map((s) => s.source_id),
      clipIds: clips.map((p) => p.id),
    };
  }

  async list(merchantId: string): Promise<{ items: FolderRecord[] }> {
    const rows: { id: string; title: string; updated_at: Date; source_ids: string[]; clip_ids: string[] }[] =
      await this.ds.query(
        `SELECT f.id,f.title,f.updated_at,
        ARRAY(SELECT fs.source_id FROM project_folder_sources fs WHERE fs.folder_id=f.id AND fs.merchant_id=$1 ORDER BY fs.created_at,fs.id) AS source_ids,
        ARRAY(SELECT p.id FROM projects p JOIN project_versions v ON v.project_id=p.id AND v.version=p.current_version AND v.merchant_id=$1
          WHERE p.merchant_id=$1 AND EXISTS (SELECT 1 FROM jsonb_each(v.doc->'assets') a JOIN project_folder_sources fs ON fs.source_id::text=a.value->>'sourceId' AND fs.folder_id=f.id AND fs.merchant_id=$1)
          ORDER BY p.updated_at DESC,p.id) AS clip_ids
        FROM project_folders f WHERE f.merchant_id=$1 ORDER BY f.updated_at DESC,f.id LIMIT 200`,
        [merchantId],
      );
    return {
      items: rows.map((row) => ({
        id: row.id,
        title: row.title,
        updatedAt: new Date(row.updated_at).toISOString(),
        sourceIds: row.source_ids,
        clipIds: row.clip_ids,
      })),
    };
  }

  async create(merchantId: string, title: string): Promise<FolderRecord> {
    const id = uuidv7();
    await this.ds.query('INSERT INTO project_folders (id,merchant_id,title) VALUES ($1,$2,$3)', [
      id,
      merchantId,
      title,
    ]);
    return this.get(merchantId, id);
  }

  async addSources(merchantId: string, id: string, sourceIds: string[]): Promise<FolderRecord> {
    return this.ds.transaction(async (em) => {
      const folder: unknown[] = await em.query(
        'SELECT id FROM project_folders WHERE id=$1 AND merchant_id=$2 FOR UPDATE',
        [id, merchantId],
      );
      if (!folder.length) throw new NotFoundException('Project folder not found');
      const ids = [...new Set(sourceIds)];
      const own: { id: string }[] = await em.query(
        'SELECT id FROM video_sources WHERE merchant_id=$1 AND id=ANY($2::uuid[]) FOR KEY SHARE',
        [merchantId, ids],
      );
      if (own.length !== ids.length) throw new NotFoundException('Source not found');
      for (const sourceId of ids)
        await em.query(
          'INSERT INTO project_folder_sources (id,merchant_id,folder_id,source_id) VALUES ($1,$2,$3,$4) ON CONFLICT (folder_id,source_id) DO NOTHING',
          [uuidv7(), merchantId, id, sourceId],
        );
      await em.query('UPDATE project_folders SET updated_at=now() WHERE id=$1 AND merchant_id=$2', [
        id,
        merchantId,
      ]);
      return this.get(merchantId, id, em);
    });
  }

  async delete(merchantId: string, id: string): Promise<void> {
    await this.ds.query('DELETE FROM project_folders WHERE id=$1 AND merchant_id=$2', [id, merchantId]);
  }
}
