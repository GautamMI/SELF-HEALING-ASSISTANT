/** Sliding-window limiter guarding how many PRs the agent may open per hour. */
export class SlidingWindowRateLimiter {
  private readonly hits: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs: number = 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    while (this.hits.length > 0 && (this.hits[0] as number) < cutoff) this.hits.shift();
  }

  get remaining(): number {
    this.prune();
    return Math.max(0, this.limit - this.hits.length);
  }

  tryAcquire(): boolean {
    this.prune();
    if (this.hits.length >= this.limit) return false;
    this.hits.push(this.now());
    return true;
  }
}
