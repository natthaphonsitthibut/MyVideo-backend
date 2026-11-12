import { readFileSync } from 'node:fs';
import { LlmBudgetError } from '@myvideo/domain';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { freshTestDb } from '../../../test/test-db.js';
import { LlmCallEntity } from '../src/db/entities/llm-call.entity.js';
import { WorkflowRunEntity } from '../src/db/entities/workflow-run.entity.js';
import { seedMerchant } from '../src/db/seed.js';
import { DbLlmCallStore } from '../src/llm/db-store.js';
import { ClaudeCliAdapter, type CliExec } from '../src/llm/local-agent-claude.js';
import { zodStructuredSchema } from '../src/llm/schema.js';
import { StructuredLlm } from '../src/llm/structured-llm.js';

/** Real recorded CLI answers replayed through the Postgres-backed cache / call log / call cap. */
const recorded = (name: string) =>
  JSON.stringify(
    (
      JSON.parse(
        readFileSync(new URL(`../src/llm/fixtures/claude-cli-${name}.json`, import.meta.url), 'utf8'),
      ) as {
        stdout: unknown;
      }
    ).stdout,
  );

describe('DbLlmCallStore (real Postgres)', () => {
  let ds: DataSource;
  let a: string;
  let b: string;
  let runId: string;
  beforeAll(async () => {
    ds = await freshTestDb();
    const seed = (n: string) =>
      seedMerchant(ds, {
        merchantName: n,
        merchantSlug: `shop-${n}`,
        email: `${n}@x.local`,
        password: `password-${n}`,
        displayName: n,
      });
    a = (await seed('a')).merchant.id;
    b = (await seed('b')).merchant.id;
    const run = await ds
      .getRepository(WorkflowRunEntity)
      .save({ merchantId: a, kind: 'live_to_clips', status: 'running' } as Partial<WorkflowRunEntity>);
    runId = run.id;
  });
  afterAll(async () => ds.destroy());

  it('logs each call with tokens and cost, caches per merchant, and caps calls per run', async () => {
    let calls = 0;
    const exec: CliExec = async (_c, args) => {
      calls++;
      return {
        code: 0,
        stdout: (args[1] ?? '').includes('80 บาท') ? recorded('price') : recorded('shipping'),
        stderrTail: '',
      };
    };
    const llm = new StructuredLlm(new ClaudeCliAdapter({ exec }), new DbLlmCallStore(ds), {
      maxCallsPerRun: 2,
    });
    const schema = zodStructuredSchema('line-class', z.object({ type: z.string(), quote: z.string() }));
    const ask = (line: string, merchantId: string, workflowRunId?: string) =>
      llm.generateStructured(
        { schema, prompt: `Sentence: ${line}`, promptVersion: 'p1' },
        { merchantId, workflowRunId },
      );

    const first = await ask('ตัวนี้รับพิมรับมา 80 บาทนะ', a, runId);
    expect(first).toMatchObject({ cached: false, value: { type: 'price', quote: '80 บาท' } });
    const again = await ask('ตัวนี้รับพิมรับมา 80 บาทนะ', a, runId);
    expect(again.cached).toBe(true);
    expect(calls).toBe(1);

    const rows = await ds.getRepository(LlmCallEntity).find();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      merchantId: a,
      workflowRunId: runId,
      status: 'ok',
      mode: 'local-agent',
      outputTokens: 77,
    });
    expect(rows[0]?.costUsdEstimate).toBeCloseTo(0.0104413, 7);

    // merchant B does not see A's cache
    await ask('ตัวนี้รับพิมรับมา 80 บาทนะ', b);
    expect(calls).toBe(2);

    await ask('ค่าจะส่ง 2 ตัวแรก 50 บาท', a, runId); // second call of the run
    await expect(ask('อีกประโยคหนึ่ง', a, runId)).rejects.toBeInstanceOf(LlmBudgetError);
    expect(calls).toBe(3);
  });
});
