import { SlidingWindowRateLimiter } from '../src/utils/rateLimiter';

describe('SlidingWindowRateLimiter', () => {
  it('allows up to the limit then blocks', () => {
    let now = 0;
    const limiter = new SlidingWindowRateLimiter(2, 1000, () => now);

    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
    expect(limiter.remaining).toBe(0);
  });

  it('frees capacity as the window slides', () => {
    let now = 0;
    const limiter = new SlidingWindowRateLimiter(1, 1000, () => now);

    expect(limiter.tryAcquire()).toBe(true);
    now = 1001;
    expect(limiter.tryAcquire()).toBe(true);
  });
});
