import { z } from 'zod';

export const STRUCTURES = [
  'problem-solution',
  'before-after',
  'reasons',
  'demonstration',
  'situation',
  'friend-review',
  'calm-brand',
  'live-offer',
] as const;
export const StoryNote = z.object({
  structure: z.enum(STRUCTURES),
  hooks: z.array(z.string().max(200)).max(3),
  selectedHook: z.number().int().min(0).max(2).nullable(),
  words: z
    .array(z.object({ text: z.string(), startMs: z.number().int(), endMs: z.number().int() }))
    .max(10000),
  beats: z.array(
    z.object({
      elementId: z.uuid(),
      sourceId: z.uuid(),
      sourceInFrame: z.number().int().min(0),
      durationFrames: z.number().int().positive(),
      wordIndexes: z.array(z.number().int().min(0)),
    }),
  ),
});
export const CriticCheck = z.object({
  checkId: z.string().regex(/^(0[1-9]|1[0-9]|2[0-6])$/),
  status: z.enum(['pass', 'fail', 'not_run']),
  severity: z.enum(['must-fix', 'review']),
  evidence: z.array(z.string().max(300)).max(200),
});
export const JudgeItem = z.object({
  elementId: z.uuid(),
  aspect: z.enum(['safe-zone', 'readability', 'motion', 'clutter', 'ending']),
  score: z.number().int().min(0).max(10),
  correction: z.enum(['none', 'caption-safe', 'reduce-motion', 'remove-optional', 'lower-music']),
  evidenceFrame: z.number().int().min(0),
});
export const DirectorReport = z.object({
  version: z.literal(1),
  story: StoryNote,
  checks: z.array(CriticCheck).length(26),
  codeFixes: z.array(z.string().max(300)).max(200).optional(),
  judge: z.object({
    status: z.enum(['reviewed', 'not_run', 'unavailable']),
    reason: z.string().max(1000).optional(),
    rounds: z
      .array(
        z.object({
          frames: z.array(z.number().int().min(0)).max(6),
          items: z.array(JudgeItem).max(30),
          fixes: z.array(z.string().max(300)).max(100),
          calls: z.number().int().min(0),
          costUsdEstimate: z.number().nullable(),
          durationMs: z.number().min(0),
        }),
      )
      .max(3),
  }),
});
