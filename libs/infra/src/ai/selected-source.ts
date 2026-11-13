import type { StoredObject } from '@myvideo/domain';
import type { EntityManager } from 'typeorm';
import { createRunInTransaction, enqueueInTransaction } from '../jobs/job-store.js';
import type { AsrResult } from './ai-service.client.js';

/** Persist the selected video as independent Library footage, with its own zero-based transcript. */
export async function saveSelectedSource(
  em: EntityManager,
  a: {
    merchantId: string;
    sourceId: string;
    parentSourceId: string;
    title: string;
    startMs: number;
    endMs: number;
    video: StoredObject & { key: string };
    audio: StoredObject & { key: string };
    asr: AsrResult;
    asrKey: string;
  },
) {
  const owned = await em.query('SELECT id FROM video_sources WHERE id=$1 AND merchant_id=$2 FOR KEY SHARE', [
    a.parentSourceId,
    a.merchantId,
  ]);
  if (!owned.length) throw new Error('Selected range source is not owned by this merchant');
  const existing = await em.query('SELECT id FROM video_sources WHERE id=$1 AND merchant_id=$2', [
    a.sourceId,
    a.merchantId,
  ]);
  if (existing.length) return;
  const provenance = { sourceId: a.parentSourceId, startMs: a.startMs, endMs: a.endMs };
  await em.query(
    `INSERT INTO video_sources(id,merchant_id,upload_id,title,original_filename,size_bytes,sha256,status) VALUES($1,$2,$3,$4,$5,$6,$7,'processing')`,
    [
      a.sourceId,
      a.merchantId,
      `selected:${a.sourceId}`,
      a.title,
      `${a.sourceId}.mp4`,
      a.video.size,
      a.video.sha256,
    ],
  );
  for (const [kind, file, contentType] of [
    ['original', a.video, 'video/mp4'],
    ['audio', a.audio, 'audio/wav'],
  ] as const)
    await em.query(
      `INSERT INTO media_assets(merchant_id,source_id,kind,recipe_version,storage_key,size_bytes,sha256,content_type,meta) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8)`,
      [
        a.merchantId,
        a.sourceId,
        kind,
        file.key,
        file.size,
        file.sha256,
        contentType,
        JSON.stringify({ selectedFrom: provenance }),
      ],
    );
  const [t] = await em.query(
    `INSERT INTO transcripts(merchant_id,source_id,audio_sha256,model,engine,recipe_version,status,duration_ms,chunk_count,language,storage_key) VALUES($1,$2,$3,$4,$5,1,'ready',$6,0,$7,$8) RETURNING id`,
    [
      a.merchantId,
      a.sourceId,
      a.audio.sha256,
      a.asr.model,
      a.asr.engine,
      a.endMs - a.startMs,
      a.asr.language,
      a.asrKey,
    ],
  );
  const duration = a.endMs - a.startMs;
  for (const [seq, s] of a.asr.segments.entries()) {
    const words = s.words
      .map((w) => ({
        text: w.text,
        kind: w.kind,
        startMs: Math.max(0, w.start_ms),
        endMs: Math.min(duration, w.end_ms),
      }))
      .filter((w) => w.endMs > w.startMs);
    if (!words.length) continue;
    await em.query(
      `INSERT INTO transcript_segments(merchant_id,transcript_id,seq,start_ms,end_ms,text,words,avg_logprob,no_speech_prob) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        a.merchantId,
        t.id,
        seq,
        Math.max(0, s.start_ms),
        Math.min(duration, s.end_ms),
        s.text,
        JSON.stringify(words),
        s.avg_logprob,
        s.no_speech_prob,
      ],
    );
  }
  // Reuse folder membership without copying the immutable parent file or changing the current edit selection.
  await em.query(
    `INSERT INTO project_folder_sources(merchant_id,folder_id,source_id) SELECT merchant_id,folder_id,$3 FROM project_folder_sources WHERE merchant_id=$1 AND source_id=$2 ON CONFLICT DO NOTHING`,
    [a.merchantId, a.parentSourceId, a.sourceId],
  );
  const run = await createRunInTransaction(em, {
    merchantId: a.merchantId,
    kind: 'ingest',
    subjectType: 'source',
    subjectId: a.sourceId,
    input: { selectedFrom: provenance },
  });
  await enqueueInTransaction(em, {
    merchantId: a.merchantId,
    workflowRunId: run.id,
    type: 'media.probe',
    queue: 'media',
    idempotencyKey: `${run.id}:media.probe`,
    payload: { sourceId: a.sourceId },
    timeoutMs: 60000,
  });
}

export function selectedVideoArgs(input: string, startMs: number, endMs: number, out: string): string[] {
  return [
    '-v',
    'error',
    '-y',
    '-nostdin',
    '-ss',
    String(startMs / 1000),
    '-i',
    input,
    '-t',
    String((endMs - startMs) / 1000),
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    out,
  ];
}
