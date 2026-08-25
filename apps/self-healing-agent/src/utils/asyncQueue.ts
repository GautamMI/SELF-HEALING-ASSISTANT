/**
 * Minimal serial task queue.
 *
 * Healing runs mutate the working tree and the git index, so exactly one may be
 * in flight at any moment. A dependency-free queue keeps that invariant obvious.
 */
export class AsyncQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private pending = 0;

  get size(): number {
    return this.pending;
  }

  push<T>(task: () => Promise<T>): Promise<T> {
    this.pending += 1;

    const run = this.chain.then(task, task);

    this.chain = run.then(
      () => {
        this.pending -= 1;
      },
      () => {
        this.pending -= 1;
      },
    );

    return run;
  }

  /** Resolves once every queued task has settled. */
  async drain(): Promise<void> {
    await this.chain;
  }
}
