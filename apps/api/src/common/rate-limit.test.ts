import { describe, expect, it } from 'vitest';
import { FixedWindowLimiter } from './rate-limit.js';

describe('fixed-window rate limiter', () => {
  it('allows `limit` hits per window per key, then refuses until the window ends', () => {
    let now = 1_000;
    const l = new FixedWindowLimiter({ limit: 3, windowMs: 60_000, now: () => now });
    expect([l.hit('a'), l.hit('a'), l.hit('a')]).toEqual([true, true, true]);
    expect(l.hit('a')).toBe(false);
    expect(l.hit('b')).toBe(true); // keys are independent
    now += 59_999;
    expect(l.hit('a')).toBe(false);
    now += 1;
    expect(l.hit('a')).toBe(true);
  });

  it('reset clears a key (a successful login forgets earlier failures); retryAfter is in seconds', () => {
    let now = 0;
    const l = new FixedWindowLimiter({ limit: 1, windowMs: 10_000, now: () => now });
    l.hit('x');
    expect(l.hit('x')).toBe(false);
    now = 4_000;
    expect(l.retryAfterSeconds('x')).toBe(6);
    l.reset('x');
    expect(l.hit('x')).toBe(true);
  });

  it('old windows are dropped so memory stays bounded', () => {
    let now = 0;
    const l = new FixedWindowLimiter({ limit: 1, windowMs: 1_000, now: () => now });
    for (let i = 0; i < 1000; i++) l.hit(`k${i}`);
    now = 5_000;
    l.hit('fresh');
    expect(l.size).toBe(1);
  });
});
