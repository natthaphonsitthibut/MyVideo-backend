import { Project } from '@myvideo/contracts';
import { expect, it } from 'vitest';
import recorded from '../../../contracts/src/project/fixtures/s01-clip.project.json' with { type: 'json' };
import { RulesOnlyLlm } from '../llm/structured-llm.js';
import { codeCritic, judgeSchema, repairJudgedItems, reviewDraft, storyNote } from './director.js';

it('keeps unmeasured audio/visual quality unknown and detects an added source outside the selected footage', () => {
  const p = Project.parse(recorded);
  const checks = codeCritic(p, { sourceIds: [], words: [], product: {} });
  expect(checks).toHaveLength(26);
  expect(checks.find((c) => c.checkId === '01')?.status).toBe('fail');
  expect(checks.find((c) => c.checkId === '20')?.status).toBe('not_run');
});
it('maps story beats to existing shot and source word indexes, retaining distinct supported hook variants', () => {
  const p = Project.parse(recorded);
  const note = storyNote(p, [{ text: 'ตัวนี้', startMs: 600000, endMs: 600600 }], ['ตัวนี้', 'ตัวนี้'], 'live-offer');
  expect(note.hooks).toEqual(['ตัวนี้']);
  expect(note.beats.every((b) => p.elements[b.elementId]?.type === 'video')).toBe(true);
  expect(note.beats.every((b) => b.wordIndexes.every((i) => i === 0))).toBe(true);
});
it('rejects unknown or duplicate judge targets and never repairs high-scored elements', () => {
  const p = Project.parse(recorded);
  const e = Object.values(p.elements).find((e) => e.type === 'caption');
  if (!e) throw new Error('recorded fixture has no captions');
  const entry = {
    elementId: e.id,
    aspect: 'safe-zone',
    score: 8,
    correction: 'caption-safe',
    evidenceFrame: 0,
  };
  expect(judgeSchema(p, [0]).parse({ items: [{ ...entry, elementId: 'unknown' }] }).ok).toBe(false);
  expect(judgeSchema(p, [0]).parse({ items: [entry, entry] }).ok).toBe(false);
  expect(repairJudgedItems(p, [entry as never]).project).toEqual(p);
  const repaired = repairJudgedItems(p, [{ ...entry, score: 7 } as never]);
  expect(repaired.fixes).toHaveLength(1);
  expect(repaired.project.elements[e.id]?.type).toBe('caption');
});

it('persists honest unrun review evidence without calling a model or rendering footage', async () => {
  const p = Project.parse(recorded);
  const sourceIds = Object.values(p.assets).flatMap((a) => (a.sourceId ? [a.sourceId] : []));
  const result = await reviewDraft({
    project: p,
    evidence: { sourceIds, words: [], product: {} },
    hooks: [],
    llm: new RulesOnlyLlm(),
    context: { merchantId: p.merchantId },
  });
  expect(Project.parse(result).meta.director?.judge).toMatchObject({ status: 'not_run', rounds: [] });
  expect(result.meta.director?.checks.find((c) => c.checkId === '20')?.status).toBe('not_run');
  await expect(
    reviewDraft({
      project: p,
      evidence: { sourceIds: [], words: [], product: {} },
      hooks: [],
      llm: new RulesOnlyLlm(),
      context: { merchantId: p.merchantId },
    }),
  ).rejects.toThrow('Clip safety validation failed');
});
