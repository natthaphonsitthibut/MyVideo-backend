import { describe, expect, it } from 'vitest';
import { HOOKS_PROMPT_VERSION, HOOKS_SYSTEM } from './hooks.js';
import { RERANK_PROMPT_VERSION, RERANK_SYSTEM } from './rerank.js';

describe('merchant-facing prompt language', () => {
  it('requests short natural Thai reasons independently of response validation', () => {
    expect(RERANK_SYSTEM).toContain('reason: one short natural Thai sentence');
    expect(RERANK_SYSTEM).toContain('at most 90 characters');
    expect(RERANK_SYSTEM).toContain('plain words a seller uses');
    expect(RERANK_SYSTEM).toContain('quote: a short Thai phrase copied character for character');
    expect(RERANK_SYSTEM).not.toContain('English sentence');
    expect(RERANK_PROMPT_VERSION).toBe('rerank-highlights-v4');
  });

  it('v4 ranks with an editor rubric: hook first, stand-alone, payoff, and one take per repeated pitch', () => {
    for (const axis of ['hook (30)', 'stand-alone (25)', 'energy (20)', 'value (15)', 'payoff (10)'])
      expect(RERANK_SYSTEM).toContain(axis);
    expect(RERANK_SYSTEM).toContain('keep only the cleanest, most complete take');
    expect(RERANK_SYSTEM).toContain('skip greetings and filler');
    expect(RERANK_SYSTEM).toContain('Never invent or translate text.');
  });

  it('already requests Thai text for both hooks and titles', () => {
    expect(HOOKS_SYSTEM).toContain('You write short Thai on-screen text');
    expect(HOOKS_SYSTEM).toContain('2 hooks (natural spoken Thai');
    expect(HOOKS_SYSTEM).toContain('1 title');
    expect(HOOKS_PROMPT_VERSION).toBe('hooks-v2');
    expect(HOOKS_SYSTEM).toContain('ONE idea');
    expect(HOOKS_SYSTEM).toContain('DIFFERENT shapes');
    expect(HOOKS_SYSTEM).toContain('Never add a price');
  });
});
