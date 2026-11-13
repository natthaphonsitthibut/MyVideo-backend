import { FrozenStyle, ReferenceGrammar as GrammarSchema } from '@myvideo/contracts';
import { uuidv7 } from '@myvideo/domain';
import type { DataSource, EntityManager } from 'typeorm';
import { ReferenceStyleEntity } from '../db/entities/reference-style.entity.js';
import { createRunInTransaction, enqueueInTransaction } from '../jobs/job-store.js';

export async function enqueueReferenceForSource(em: EntityManager, sourceId: string, merchantId: string) {
  const rows: { id: string; run_id: string }[] = await em.query(
    `SELECT r.id,r.run_id FROM reference_styles r JOIN video_sources s ON s.id=r.source_id AND s.merchant_id=r.merchant_id WHERE r.source_id=$1 AND r.merchant_id=$2 AND r.status='waiting' AND s.status='ready' FOR UPDATE OF r`,
    [sourceId, merchantId],
  );
  for (const row of rows) {
    await enqueueInTransaction(em, {
      merchantId,
      workflowRunId: row.run_id,
      type: 'reference.analyse',
      queue: 'ai',
      idempotencyKey: `${row.run_id}:reference`,
      payload: { referenceId: row.id },
      timeoutMs: 15 * 60000,
    });
    await em.query(
      "UPDATE reference_styles SET status='processing',error=NULL,updated_at=now() WHERE id=$1 AND merchant_id=$2",
      [row.id, merchantId],
    );
  }
}
export class ReferenceUnavailableError extends Error {
  constructor(
    readonly reason: 'not_found' | 'used' | 'not_ready',
    message: string,
  ) {
    super(message);
  }
}
export async function createReference(ds: DataSource, merchantId: string, sourceId: string, title: string) {
  return ds.transaction(async (em) => {
    const sources: {
      status: string;
      probe: { still?: boolean; durationMs: number } | null;
      original_filename: string;
    }[] = await em.query(
      'SELECT status,probe,original_filename FROM video_sources WHERE id=$1 AND merchant_id=$2 FOR UPDATE',
      [sourceId, merchantId],
    );
    const s = sources[0];
    if (!s) throw new ReferenceUnavailableError('not_found', 'ไม่พบคลิปนี้');
    const existing = await em.getRepository(ReferenceStyleEntity).findOneBy({ sourceId, merchantId });
    if (existing) return existing.id;
    if (
      s.probe?.still ||
      /\.(png|jpe?g|webp)$/i.test(s.original_filename) ||
      (s.probe && s.probe.durationMs > 120000)
    )
      throw new ReferenceUnavailableError('not_ready', 'คลิปอ้างอิงต้องเป็นวิดีโอไม่เกิน 2 นาที');
    const used = await em.query(
      `SELECT 1 FROM project_folder_sources WHERE source_id=$1 AND merchant_id=$2 UNION ALL SELECT 1 FROM project_versions WHERE merchant_id=$2 AND EXISTS(SELECT 1 FROM jsonb_each(doc->'assets') a WHERE a.value->>'sourceId'=$1::text) LIMIT 1`,
      [sourceId, merchantId],
    );
    if (used.length)
      throw new ReferenceUnavailableError('used', 'คลิปนี้ใช้อยู่ในโปรเจกต์แล้ว อัปโหลดคลิปอ้างอิงแยกอีกไฟล์');
    const id = uuidv7(),
      run = await createRunInTransaction(em, {
        merchantId,
        kind: 'ingest',
        subjectType: 'reference',
        subjectId: id,
        input: { sourceId },
      });
    await em.getRepository(ReferenceStyleEntity).insert({
      id,
      merchantId,
      sourceId,
      title,
      status: 'waiting',
      runId: run.id,
      snapshot: null,
      grammar: null,
      error: null,
    });
    await enqueueReferenceForSource(em, sourceId, merchantId);
    return id;
  });
}
export async function retryReference(ds: DataSource, merchantId: string, id: string) {
  await ds.transaction(async (em) => {
    const rows: { source_id: string; status: string }[] = await em.query(
      'SELECT source_id,status FROM reference_styles WHERE id=$1 AND merchant_id=$2 FOR UPDATE',
      [id, merchantId],
    );
    const r = rows[0];
    if (!r) throw new ReferenceUnavailableError('not_found', 'ไม่พบคลิปอ้างอิง');
    if (r.status === 'ready' || r.status === 'processing') return;
    const run = await createRunInTransaction(em, {
      merchantId,
      kind: 'ingest',
      subjectType: 'reference',
      subjectId: id,
      input: { sourceId: r.source_id },
    });
    await em.query(
      "UPDATE reference_styles SET status='waiting',run_id=$3,error=NULL,updated_at=now() WHERE id=$1 AND merchant_id=$2",
      [id, merchantId, run.id],
    );
    await enqueueReferenceForSource(em, r.source_id, merchantId);
  });
}
export async function referenceRecords(db: DataSource, merchantId: string) {
  const rows: {
    id: string;
    source_id: string;
    title: string;
    status: string;
    source_status: string;
    snapshot: unknown;
    grammar: unknown;
    error: string | null;
    failure_reason: string | null;
  }[] = await db.query(
    `SELECT r.*,s.status AS source_status,s.failure_reason FROM reference_styles r JOIN video_sources s ON s.id=r.source_id AND s.merchant_id=r.merchant_id WHERE r.merchant_id=$1 ORDER BY r.created_at DESC LIMIT 100`,
    [merchantId],
  );
  return rows.map((r) => ({
    id: r.id,
    sourceId: r.source_id,
    title: r.title,
    status: r.source_status === 'failed' ? 'failed' : r.status,
    sourceStatus: r.source_status,
    styleId: r.snapshot ? FrozenStyle.parse(r.snapshot).pack.id : null,
    grammar: r.grammar ? GrammarSchema.parse(r.grammar) : null,
    error: r.error ?? r.failure_reason,
  }));
}
export async function customStyles(
  db: DataSource | EntityManager,
  merchantId: string,
): Promise<FrozenStyle[]> {
  const rows: { snapshot: unknown }[] = await db.query(
    "SELECT snapshot FROM reference_styles WHERE merchant_id=$1 AND status='ready' ORDER BY created_at DESC LIMIT 100",
    [merchantId],
  );
  return rows.map((r) => FrozenStyle.parse(r.snapshot));
}
export async function customStyle(db: DataSource | EntityManager, merchantId: string, id: string) {
  return (await customStyles(db, merchantId)).find((s) => s.pack.id === id) ?? null;
}
