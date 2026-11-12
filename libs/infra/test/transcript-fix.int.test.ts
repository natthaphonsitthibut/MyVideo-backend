import { readFileSync } from 'node:fs';
import { type LlmPort, uuidv7 } from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshTestDb } from '../../../test/test-db.js';
import { transcriptFixHandler } from '../src/ai/transcript-fix.js';
import {
  TranscriptEditEntity,
  TranscriptEntity,
  TranscriptSegmentEntity,
} from '../src/db/entities/transcript.entity.js';
import { seedMerchant } from '../src/db/seed.js';
import { loadCorrectedTranscript } from '../src/highlights/live-to-clips.js';
import type { JobContext } from '../src/jobs/handlers.js';

// Stored real transcript input; stub corrections exercise persistence, not model quality.
const fixture = JSON.parse(
  readFileSync(new URL('../../../services/ai/tests/fixtures/asr-real.json', import.meta.url), 'utf8'),
)['talkinghead-th-portrait'] as { segments: { text: string; start_ms: number; end_ms: number }[] };
describe('whole transcript correction persistence', () => {
  let ds: DataSource;
  let merchantId: string;
  let calls = 0;
  const llm: LlmPort = {
    mode: 'local-agent',
    async generateStructured(request) {
      calls++;
      // two calls per pass: the whole-video context (no glossary here), then the sentence rewrite per batch
      const input = JSON.parse(request.prompt) as { lines?: { id: string; heard: string }[] };
      const value = input.lines
        ? { lines: input.lines.map((l) => ({ id: l.id, text: l.heard.replace('ไลฟ์', 'ไลฟ') })) }
        : { topic: '', terms: [] };
      const parsed = request.schema.parse(value);
      if (!parsed.ok) throw new Error(parsed.error);
      return {
        value: parsed.value,
        mode: 'local-agent',
        model: 'stub',
        cached: false,
        calls: 1,
        durationMs: 0,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsdEstimate: null,
        },
      };
    },
  };
  beforeAll(async () => {
    ds = await freshTestDb();
    merchantId = (
      await seedMerchant(ds, {
        merchantName: 'Fix',
        merchantSlug: 'fix-test',
        email: 'fix@test.local',
        password: 'test-password',
        displayName: 'Fix',
      })
    ).merchant.id;
  });
  afterAll(async () => {
    await ds?.destroy();
  });
  async function setup() {
    const sourceId = uuidv7();
    await ds.query(
      `INSERT INTO video_sources (id, merchant_id, upload_id, title, original_filename, size_bytes, sha256, status) VALUES ($1,$2,$3,'test','test.mp4',10,'test','ready')`,
      [sourceId, merchantId, `test-${sourceId}`],
    );
    const t = await ds.getRepository(TranscriptEntity).save({
      merchantId,
      sourceId,
      audioSha256: 'recorded',
      model: 'recorded',
      engine: 'recorded',
      recipeVersion: 1,
      durationMs: 54500,
      status: 'ready',
    });
    await ds.getRepository(TranscriptSegmentEntity).insert(
      fixture.segments.map((s, seq) => ({
        merchantId,
        transcriptId: t.id,
        seq,
        startMs: s.start_ms,
        endMs: s.end_ms,
        text: s.text,
        words: [{ text: s.text, startMs: s.start_ms, endMs: s.end_ms, kind: 'word' }],
      })),
    );
    const ctx = {
      job: { merchantId, workflowRunId: null, payload: { transcriptId: t.id } },
      signal: new AbortController().signal,
      progress: async () => {},
      attempt: 1,
    } as unknown as JobContext;
    return { t, ctx, sourceId };
  }
  it('writes AI edits, preserves user edits and raw rows, carries provenance, and is idempotent after revert', async () => {
    const { t, ctx, sourceId } = await setup();
    const protectedSeq = fixture.segments.findIndex((s) => s.text.includes('ไลฟ์'));
    expect(protectedSeq).toBeGreaterThanOrEqual(0);
    await ds.getRepository(TranscriptEditEntity).insert({
      merchantId,
      transcriptId: t.id,
      seq: protectedSeq,
      wordIndex: 0,
      text: 'คำที่แม่ค้าเลือก',
      origin: 'user',
    });
    const before = await ds.getRepository(TranscriptSegmentEntity).findBy({ transcriptId: t.id });
    const handler = transcriptFixHandler({ ds, llm });
    await handler.run(ctx);
    const rows = await ds
      .getRepository(TranscriptEditEntity)
      .find({ where: { transcriptId: t.id }, order: { seq: 'ASC' } });
    expect(rows.some((r) => r.origin === 'ai')).toBe(true);
    expect(rows.find((r) => r.seq === protectedSeq)).toMatchObject({ origin: 'user', text: 'คำที่แม่ค้าเลือก' });
    expect(await ds.getRepository(TranscriptSegmentEntity).findBy({ transcriptId: t.id })).toEqual(before);
    const corrected = await loadCorrectedTranscript(ds, merchantId, sourceId);
    expect(corrected.aiFixed).toBe(true);
    const ai = rows.find((r) => r.origin === 'ai')!;
    expect(corrected.segments[ai.seq]?.words[0]).toMatchObject({
      text: ai.text,
      origin: 'ai',
      asrText: fixture.segments[ai.seq]?.text,
    });
    expect(corrected.segments[protectedSeq]?.words[0]?.text).toBe('คำที่แม่ค้าเลือก');
    const count = calls;
    await handler.run(ctx);
    expect(
      await ds
        .getRepository(TranscriptEditEntity)
        .find({ where: { transcriptId: t.id }, order: { seq: 'ASC' } }),
    ).toEqual(rows);
    await ds.getRepository(TranscriptEditEntity).delete(ai.id);
    await handler.run(ctx);
    expect(calls).toBe(count);
    expect(await ds.getRepository(TranscriptEditEntity).findOneBy({ id: ai.id })).toBeNull();
  });
  it('a merged name is one word for clips (span audio) and the context is stored', async () => {
    const { t, sourceId } = await setup();
    // two real segments made into one 3-word segment: words 1–2 merged into a name by the AI
    const seg = fixture.segments[0] as { text: string; start_ms: number; end_ms: number };
    const third = (seg.end_ms - seg.start_ms) / 3;
    await ds.getRepository(TranscriptSegmentEntity).update(
      { transcriptId: t.id, seq: 0 },
      {
        words: ['ของ', 'ควิก', 'บู'].map((text, i) => ({
          text,
          kind: 'word',
          startMs: Math.round(seg.start_ms + i * third),
          endMs: Math.round(seg.start_ms + (i + 1) * third),
        })),
      },
    );
    await ds.getRepository(TranscriptEditEntity).insert([
      { merchantId, transcriptId: t.id, seq: 0, wordIndex: 1, text: 'Liquid Blue', origin: 'ai' },
      { merchantId, transcriptId: t.id, seq: 0, wordIndex: 2, text: '', origin: 'ai' },
    ]);
    const corrected = await loadCorrectedTranscript(ds, merchantId, sourceId);
    const words = corrected.segments[0]?.words ?? [];
    expect(words.map((w) => w.text)).toEqual(['ของ', 'Liquid Blue']);
    expect(words[1]).toMatchObject({ origin: 'ai', asrText: 'ควิก บู', endMs: Math.round(seg.end_ms) });
    // an empty text is refused for a merchant edit (only AI continuations may be empty)
    await expect(
      ds.query(
        `INSERT INTO transcript_edits (merchant_id, transcript_id, seq, word_index, text, origin) VALUES ($1, $2, 1, 0, '', 'user')`,
        [merchantId, t.id],
      ),
    ).rejects.toThrow();
    await ds.getRepository(TranscriptEntity).update(
      { id: t.id },
      {
        aiContext: {
          topic: 'ไลฟ์ขายเสื้อมัดย้อม',
          terms: [{ term: 'Liquid Blue', kind: 'brand', heardAs: ['ควิก บู'] }],
        },
      },
    );
    expect((await ds.getRepository(TranscriptEntity).findOneByOrFail({ id: t.id })).aiContext).toMatchObject({
      topic: 'ไลฟ์ขายเสื้อมัดย้อม',
    });
  });
  it('rules and unavailable models leave the transcript usable without edits', async () => {
    for (const mode of ['rules', 'local-agent'] as const) {
      const { t, ctx } = await setup();
      await transcriptFixHandler({
        ds,
        llm: {
          mode,
          generateStructured: async () => {
            throw new Error('unavailable');
          },
        },
      }).run(ctx);
      expect(await ds.getRepository(TranscriptEditEntity).countBy({ transcriptId: t.id })).toBe(0);
      expect(await ds.getRepository(TranscriptEntity).findOneByOrFail({ id: t.id })).toMatchObject({
        status: 'ready',
      });
    }
  });
  it('cancellation writes neither edits nor completion marker; another merchant cannot read it', async () => {
    const { t, ctx } = await setup();
    const controller = new AbortController();
    const cancelling: LlmPort = {
      ...llm,
      async generateStructured(request, context) {
        const result = await llm.generateStructured(request, context);
        controller.abort(new Error('cancelled'));
        return result;
      },
    };
    await expect(
      transcriptFixHandler({ ds, llm: cancelling }).run({ ...ctx, signal: controller.signal }),
    ).rejects.toThrow('cancelled');
    expect(await ds.getRepository(TranscriptEditEntity).countBy({ transcriptId: t.id })).toBe(0);
    expect(await ds.getRepository(TranscriptEntity).findOneByOrFail({ id: t.id })).toMatchObject({
      aiFixCompleted: false,
    });
    await expect(
      transcriptFixHandler({ ds, llm }).run({ ...ctx, job: { ...ctx.job, merchantId: uuidv7() } }),
    ).rejects.toThrow('transcript not found');
  });
});
