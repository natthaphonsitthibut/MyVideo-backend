import { type FolderPlanResponse, type FolderRecord, FolderSettings, STYLE_PACKS } from '@myvideo/contracts';
import { uuidv7 } from '@myvideo/domain';
import {
  chooseFolderStyle,
  type Env,
  FolderEditUnavailableError,
  folderPlanOf,
  getStyleLock,
  lockStyle,
  requestFolderEdit,
  stylePreview,
  unlockStyle,
} from '@myvideo/infra';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ENV } from '../config/env.module.js';

@Injectable()
export class FoldersService {
  constructor(
    @Inject(DataSource) private readonly ds: DataSource,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async get(merchantId: string, id: string, em: DataSource | EntityManager = this.ds): Promise<FolderRecord> {
    const rows: { id: string; title: string; settings: unknown; updated_at: Date }[] = await em.query(
      'SELECT id,title,settings,updated_at FROM project_folders WHERE id=$1 AND merchant_id=$2',
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
      settings: FolderSettings.parse(row.settings ?? {}),
      updatedAt: new Date(row.updated_at).toISOString(),
      sourceIds: sources.map((s) => s.source_id),
      clipIds: clips.map((p) => p.id),
    };
  }

  async list(merchantId: string): Promise<{ items: FolderRecord[] }> {
    const rows: {
      id: string;
      title: string;
      settings: unknown;
      updated_at: Date;
      source_ids: string[];
      clip_ids: string[];
    }[] = await this.ds.query(
      `SELECT f.id,f.title,f.settings,f.updated_at,
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
        settings: FolderSettings.parse(row.settings ?? {}),
        updatedAt: new Date(row.updated_at).toISOString(),
        sourceIds: row.source_ids,
        clipIds: row.clip_ids,
      })),
    };
  }

  async create(merchantId: string, title: string, settings?: FolderSettings): Promise<FolderRecord> {
    const id = uuidv7();
    await this.ds.query('INSERT INTO project_folders (id,merchant_id,title,settings) VALUES ($1,$2,$3,$4)', [
      id,
      merchantId,
      title,
      JSON.stringify(FolderSettings.parse(settings ?? {})),
    ]);
    return this.get(merchantId, id);
  }

  async update(
    merchantId: string,
    id: string,
    patch: { title?: string; settings?: FolderSettings },
  ): Promise<FolderRecord> {
    const rows: unknown[] = await this.ds.query(
      `UPDATE project_folders SET title=COALESCE($3,title), settings=COALESCE($4::jsonb,settings), updated_at=now()
        WHERE id=$1 AND merchant_id=$2 RETURNING id`,
      [
        id,
        merchantId,
        patch.title ?? null,
        patch.settings ? JSON.stringify(FolderSettings.parse(patch.settings)) : null,
      ],
    );
    if (!rows.length) throw new NotFoundException('Project folder not found');
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

  /** Plan panel + style proposals, both read from real state (no estimate, no invented reason). */
  async plan(merchantId: string, id: string): Promise<FolderPlanResponse> {
    const folder = await this.get(merchantId, id); // 404 for another merchant's folder
    const { runId, styleId, plan, facts } = await folderPlanOf(this.ds, merchantId, id);
    const locked = await getStyleLock(this.ds, merchantId);
    // the analysis advice of the longest speech video ranks the styles for this footage
    const speech = facts.sources.filter((s) => s.kind === 'video' && s.hasAudio).map((s) => s.id);
    const advice: {
      result: { advice?: { origin: 'ai' | 'rules'; items: { styleId: string; reason: string }[] } };
    }[] = speech.length
      ? await this.ds.query(
          `SELECT j.result FROM workflow_runs r
               JOIN jobs j ON j.workflow_run_id = r.id AND j.type = 'clips.plan' AND j.status = 'succeeded'
               JOIN video_sources s ON s.id = r.subject_id AND s.merchant_id = r.merchant_id
              WHERE r.merchant_id = $1 AND r.kind = 'live_to_clips' AND r.status = 'succeeded' AND r.subject_id = ANY($2::uuid[])
              ORDER BY (s.probe->>'durationMs')::bigint DESC NULLS LAST, r.created_at DESC LIMIT 1`,
          [merchantId, speech],
        )
      : [];
    const ranked = advice[0]?.result?.advice;
    const proposals: FolderPlanResponse['proposals'] = [];
    for (const item of ranked?.items ?? []) {
      const pack = STYLE_PACKS.find((p) => p.id === item.styleId);
      if (pack && !proposals.some((p) => p.styleId === pack.id))
        proposals.push({
          styleId: pack.id,
          name: pack.name,
          description: pack.description,
          reason: item.reason,
          origin: ranked?.origin ?? 'rules',
        });
    }
    // no analysis to rank by (photos / silent footage), or fewer than 3 ranked: the rest of the catalogue, unranked
    if (plan.needs === 'style')
      for (const pack of STYLE_PACKS)
        if (proposals.length < 3 && !proposals.some((p) => p.styleId === pack.id))
          proposals.push({
            styleId: pack.id,
            name: pack.name,
            description: pack.description,
            reason: null,
            origin: 'catalogue',
          });
    // the style step names the style the merchant knows, not its id
    const picked = styleId ? STYLE_PACKS.find((p) => p.id === styleId) : undefined;
    const steps = plan.steps.map((s) => (s.id === 'style' && picked ? { ...s, detail: picked.name } : s));
    if (locked) {
      const i = proposals.findIndex((p) => p.styleId === locked.pack.id);
      if (i >= 0) proposals.splice(i, 1);
      proposals.unshift({
        styleId: locked.pack.id,
        name: locked.pack.name,
        description: locked.pack.description,
        reason: 'สไตล์ที่คุณล็อกไว้',
        origin: 'catalogue',
      });
    }
    const previewSource = speech[0] ?? facts.sources[0]?.id;
    if (previewSource) {
      const [segment] = (await this.ds.query(
        `SELECT s.words FROM transcript_segments s JOIN transcripts t ON t.id=s.transcript_id AND t.merchant_id=s.merchant_id WHERE t.source_id=$1 AND t.merchant_id=$2 AND t.status='ready' ORDER BY t.created_at DESC,s.seq ASC LIMIT 1`,
        [previewSource, merchantId],
      )) as { words: { text: string; startMs: number; endMs: number }[] }[];
      for (const p of proposals) {
        const pack =
          locked?.pack.id === p.styleId ? locked.pack : STYLE_PACKS.find((s) => s.id === p.styleId);
        if (pack)
          p.preview = stylePreview(pack, previewSource, segment?.words ?? [], folder.settings.productName);
      }
    }
    return {
      runId,
      styleId,
      ...plan,
      steps,
      proposals: proposals.slice(0, 3),
      lockedStyle: locked ? { styleId: locked.pack.id, name: locked.pack.name } : null,
    };
  }

  async startEdit(
    merchantId: string,
    id: string,
    styleId?: string,
    sourceIds?: string[],
  ): Promise<FolderPlanResponse> {
    if (styleId && !STYLE_PACKS.some((p) => p.id === styleId))
      throw new BadRequestException({ error: 'unknown_style', message: `ไม่มีสไตล์ "${styleId}"` });
    try {
      await requestFolderEdit(this.ds, {
        merchantId,
        folderId: id,
        sourceIds,
        styleId: styleId ?? null,
        maxUnfinishedRuns: this.env.MERCHANT_MAX_ACTIVE_RUNS,
      });
    } catch (err) {
      if (err instanceof FolderEditUnavailableError) {
        if (err.reason === 'not_found') throw new NotFoundException('Project folder not found');
        if (err.reason === 'invalid_selection')
          throw new BadRequestException('เลือกฟุตเทจในโปรเจกต์นี้อย่างน้อย 1 ไฟล์');
        throw new ConflictException('ยังไม่มีฟุตเทจในโปรเจกต์นี้ อัปโหลดวิดีโอหรือรูปก่อน');
      }
      throw err;
    }
    return this.plan(merchantId, id);
  }

  async chooseStyle(
    merchantId: string,
    id: string,
    styleId: string,
    saveLock = false,
  ): Promise<FolderPlanResponse> {
    if (!STYLE_PACKS.some((p) => p.id === styleId))
      throw new BadRequestException({ error: 'unknown_style', message: `ไม่มีสไตล์ "${styleId}"` });
    await this.get(merchantId, id);
    if (saveLock) await lockStyle(this.ds, merchantId, styleId);
    const done = await chooseFolderStyle(this.ds, { merchantId, folderId: id, styleId });
    if (!done) throw new ConflictException('ยังไม่ได้เริ่มตัดต่อโปรเจกต์นี้ กด "เริ่มตัดต่อ" ก่อน');
    return this.plan(merchantId, id);
  }
  async unlockStyle(merchantId: string): Promise<void> {
    await unlockStyle(this.ds, merchantId);
  }

  async delete(merchantId: string, id: string): Promise<void> {
    await this.ds.query('DELETE FROM project_folders WHERE id=$1 AND merchant_id=$2', [id, merchantId]);
  }
}
