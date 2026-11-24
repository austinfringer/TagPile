import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rateLimit.ts';

describe('RateLimiter', () => {
  it('blocks a key after the maximum failures until the window ends', () => {
    let now = 0;
    const limiter = new RateLimiter(3, 10_000, () => now);
    for (let i = 0; i < 3; i++) {
      expect(limiter.retryAfter('k')).toBe(0);
      limiter.fail('k');
    }
    expect(limiter.retryAfter('k')).toBe(10);
    expect(limiter.retryAfter('other')).toBe(0);
    now = 10_000;
    expect(limiter.retryAfter('k')).toBe(0);
  });

  it('undo and reset take failures back', () => {
    const limiter = new RateLimiter(2, 10_000, () => 0);
    limiter.fail('k');
    limiter.fail('k');
    limiter.undo('k');
    expect(limiter.retryAfter('k')).toBe(0);
    limiter.fail('k');
    expect(limiter.retryAfter('k')).toBe(10);
    limiter.reset('k');
    expect(limiter.retryAfter('k')).toBe(0);
  });
});
