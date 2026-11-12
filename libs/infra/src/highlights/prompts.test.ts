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
    expect(RERANK_PROMPT_VERSION).toBe('rerank-highlights-v2');
  });

  it('already requests Thai text for both hooks and titles', () => {
    expect(HOOKS_SYSTEM).toContain('You write short Thai on-screen text');
    expect(HOOKS_SYSTEM).toContain('2 hooks (natural spoken Thai');
    expect(HOOKS_SYSTEM).toContain('1 title');
    expect(HOOKS_PROMPT_VERSION).toBe('hooks-v1');
  });
});
