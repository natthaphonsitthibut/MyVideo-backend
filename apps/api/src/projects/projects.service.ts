import {
  type ProjectDraft,
  type ProjectRecord,
  type ProjectVersionList,
  validateProject,
} from '@myvideo/contracts';
import { uuidv7 } from '@myvideo/domain';
import {
  cancelSubjectWork,
  enqueuePurge,
  ProjectEntity,
  ProjectVersionEntity,
  renderPrefix,
} from '@myvideo/infra';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import type { z } from 'zod';

type VersionList = z.infer<typeof ProjectVersionList>;

const CONFLICT = 'โปรเจกต์นี้ถูกบันทึกจากที่อื่นไปแล้ว โหลดเวอร์ชันล่าสุดก่อนแล้วค่อยแก้ต่อ (version conflict)';

type ProjectSummaryDto = {
  id: string;
  title: string;
  version: number;
  createdBy: 'ai' | 'user';
  durationFrames: number;
  fps: { num: number; den: number };
  updatedAt: string;
};

@Injectable()
export class ProjectsService {
  constructor(@Inject(DataSource) private readonly ds: DataSource) {}

  /**
   * Full validation of a document before it is stored: the pure validator plus merchant ownership of every
   * source the assets point to (ARCHITECTURE §6: every referenced asset belongs to the merchant).
   */
  private async checked(merchantId: string, projectId: string, draft: ProjectDraft) {
    const r = validateProject({ ...draft, id: projectId, merchantId });
    if (!r.ok) {
      throw new BadRequestException({
        error: 'invalid_project',
        message: r.errors[0]?.message ?? 'invalid project',
        issues: r.errors.map((e) => ({ path: e.path, message: `${e.code}: ${e.message}` })),
      });
    }
    // library sounds (D-026) are product assets, not merchant data: only sources are checked for ownership
    const sourceIds = [
      ...new Set(Object.values(r.project.assets).flatMap((a) => (a.sourceId ? [a.sourceId] : []))),
    ];
    if (sourceIds.length) {
      const own: { id: string }[] = await this.ds.query(
        `SELECT id FROM video_sources WHERE merchant_id = $1 AND id = ANY($2::uuid[])`,
        [merchantId, sourceIds],
      );
      const mine = new Set(own.map((x) => x.id));
      const missing = Object.entries(r.project.assets).filter(
        ([, a]) => a.sourceId !== undefined && !mine.has(a.sourceId),
      );
      if (missing.length) {
        throw new BadRequestException({
          error: 'invalid_project',
          message: 'project uses a video that does not exist',
          issues: missing.map(([k, a]) => ({
            path: `assets.${k}.sourceId`,
            message: `missing_asset: source ${a.sourceId} does not exist`,
          })),
        });
      }
    }
    return r.project;
  }

  private async record(
    em: EntityManager | DataSource,
    merchantId: string,
    id: string,
  ): Promise<ProjectRecord> {
    const p = await em.getRepository(ProjectEntity).findOneBy({ id, merchantId });
    if (!p) throw new NotFoundException('Project not found');
    const v = await em
      .getRepository(ProjectVersionEntity)
      .findOneByOrFail({ projectId: id, version: p.currentVersion });
    return {
      id: p.id,
      title: p.title,
      version: p.currentVersion,
      doc: v.doc as ProjectRecord['doc'],
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    };
  }

  /**
   * Deletes a project (E12-F02): its work is cancelled, versions and renders go with it (FK cascade), render
   * files are removed by a purge job. Sources stay. Unknown / another merchant's id: no change (idempotent).
   */
  async delete(merchantId: string, id: string): Promise<void> {
    await this.ds.transaction(async (em) => {
      const locked: { id: string }[] = await em.query(
        'SELECT id FROM projects WHERE id = $1 AND merchant_id = $2 FOR UPDATE',
        [id, merchantId],
      );
      if (locked.length === 0) return;
      await cancelSubjectWork(em, merchantId, { projectIds: [id] });
      const renders: { id: string }[] = await em.query(
        'SELECT id FROM renders WHERE merchant_id = $1 AND project_id = $2',
        [merchantId, id],
      );
      await em.query('DELETE FROM projects WHERE id = $1 AND merchant_id = $2', [id, merchantId]);
      if (renders.length > 0)
        await enqueuePurge(
          em,
          merchantId,
          { type: 'project', id },
          renders.map((r) => renderPrefix(merchantId, r.id)),
        );
    });
  }

  async create(merchantId: string, title: string, draft: ProjectDraft): Promise<ProjectRecord> {
    const id = uuidv7();
    const doc = await this.checked(merchantId, id, draft);
    return this.ds.transaction(async (em) => {
      await em.getRepository(ProjectEntity).insert({ id, merchantId, title, currentVersion: 1 });
      await em
        .getRepository(ProjectVersionEntity)
        .insert({ merchantId, projectId: id, version: 1, doc, reason: 'create', restoredFrom: null });
      return this.record(em, merchantId, id);
    });
  }

  /** Newest change first; doc fields read in SQL so the list stays small. */
  async list(merchantId: string): Promise<{ items: ProjectSummaryDto[] }> {
    const rows: {
      id: string;
      title: string;
      version: number;
      created_by: 'ai' | 'user';
      duration_frames: number;
      fps_num: number;
      fps_den: number;
      updated_at: Date;
    }[] = await this.ds.query(
      `SELECT p.id, p.title, p.current_version AS version, v.doc->'meta'->>'createdBy' AS created_by,
              (v.doc->>'durationFrames')::int AS duration_frames, (v.doc->'fps'->>'num')::int AS fps_num,
              (v.doc->'fps'->>'den')::int AS fps_den, p.updated_at
         FROM projects p JOIN project_versions v ON v.project_id = p.id AND v.version = p.current_version
        WHERE p.merchant_id = $1 ORDER BY p.updated_at DESC LIMIT 200`,
      [merchantId],
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        title: r.title,
        version: r.version,
        createdBy: r.created_by === 'ai' ? 'ai' : 'user',
        durationFrames: r.duration_frames,
        fps: { num: r.fps_num, den: r.fps_den },
        updatedAt: new Date(r.updated_at).toISOString(),
      })),
    };
  }

  get(merchantId: string, id: string): Promise<ProjectRecord> {
    return this.record(this.ds, merchantId, id);
  }

  /**
   * Optimistic lock: the version only moves if it is still `baseVersion` (one conditional UPDATE, so of two
   * concurrent saves on the same base exactly one row update succeeds; the other gets 409).
   */
  private async append(
    merchantId: string,
    id: string,
    baseVersion: number,
    doc: Record<string, unknown>,
    reason: 'save' | 'restore',
    restoredFrom: number | null,
  ): Promise<ProjectRecord> {
    return this.ds.transaction(async (em) => {
      const [rows]: [{ current_version: number }[], number] = await em.query(
        `UPDATE projects SET current_version = current_version + 1, updated_at = now()
          WHERE id = $1 AND merchant_id = $2 AND current_version = $3 RETURNING current_version`,
        [id, merchantId, baseVersion],
      );
      const next = rows[0]?.current_version;
      if (next === undefined) {
        const exists = await em.getRepository(ProjectEntity).existsBy({ id, merchantId });
        if (!exists) throw new NotFoundException('Project not found');
        throw new ConflictException({ error: 'version_conflict', message: CONFLICT });
      }
      await em
        .getRepository(ProjectVersionEntity)
        .insert({ merchantId, projectId: id, version: next, doc: doc as never, reason, restoredFrom });
      return this.record(em, merchantId, id);
    });
  }

  async save(
    merchantId: string,
    id: string,
    baseVersion: number,
    draft: ProjectDraft,
  ): Promise<ProjectRecord> {
    // another merchant's project is simply "not found" — before any validation detail can leak
    if (!(await this.ds.getRepository(ProjectEntity).existsBy({ id, merchantId })))
      throw new NotFoundException('Project not found');
    const doc = await this.checked(merchantId, id, draft);
    return this.append(merchantId, id, baseVersion, doc, 'save', null);
  }

  async versions(merchantId: string, id: string): Promise<VersionList> {
    const exists = await this.ds.getRepository(ProjectEntity).existsBy({ id, merchantId });
    if (!exists) throw new NotFoundException('Project not found');
    const rows = await this.ds.getRepository(ProjectVersionEntity).find({
      where: { projectId: id, merchantId },
      order: { version: 'DESC' },
      select: { version: true, createdAt: true, reason: true, restoredFrom: true },
    });
    return {
      items: rows.map((r) => ({
        version: r.version,
        createdAt: r.createdAt.toISOString(),
        reason: r.reason,
        restoredFrom: r.restoredFrom,
      })),
    };
  }

  /** One saved version (merchant-scoped) — the editor previews it before a restore. */
  async version(
    merchantId: string,
    id: string,
    version: number,
  ): Promise<{ version: number; createdAt: string; doc: ProjectRecord['doc'] }> {
    const row = await this.ds
      .getRepository(ProjectVersionEntity)
      .findOneBy({ projectId: id, merchantId, version });
    if (!row) throw new NotFoundException('Version not found');
    return {
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      doc: row.doc as ProjectRecord['doc'],
    };
  }

  /** Copies an old version's doc into a NEW version (history is never rewritten). */
  async restore(
    merchantId: string,
    id: string,
    version: number,
    baseVersion: number,
  ): Promise<ProjectRecord> {
    const old = await this.ds
      .getRepository(ProjectVersionEntity)
      .findOneBy({ projectId: id, merchantId, version });
    if (!old) throw new NotFoundException('Version not found');
    return this.append(merchantId, id, baseVersion, old.doc, 'restore', version);
  }
}
