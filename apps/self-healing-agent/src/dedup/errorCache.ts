import { createLogger } from '../utils/logger';
import { config } from '../config/env';

const log = createLogger('error-cache');

interface CacheEntry {
  firstSeenAt: number;
  lastSeenAt: number;
  hits: number;
  /** Set once a PR has been raised, so repeats are never re-processed. */
  resolvedBy?: string;
}

/**
 * In-memory TTL cache keyed by error fingerprint.
 *
 * Purpose is twofold:
 *  1. Cost control - one OpenAI call per distinct defect, not per occurrence.
 *  2. Blast-radius control - a crash-looping service cannot spam a repository
 *     with hundreds of near-identical pull requests.
 */
export class ErrorCache {
  private readonly entries = new Map<string, CacheEntry>();
  private sweeper?: NodeJS.Timeout;

  constructor(
    private readonly ttlMs: number = config.dedup.ttlMs,
    private readonly maxEntries: number = config.dedup.maxEntries,
    private readonly now: () => number = Date.now,
  ) {}

  /** Starts the background sweeper. Unref'd so it never keeps Node alive. */
  startSweeper(intervalMs = Math.max(30_000, Math.floor(this.ttlMs / 4))): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), intervalMs);
    this.sweeper.unref();
  }

  stopSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
  }

  private sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    let removed = 0;

    for (const [fingerprint, entry] of this.entries) {
      if (entry.lastSeenAt < cutoff) {
        this.entries.delete(fingerprint);
        removed += 1;
      }
    }

    if (removed > 0) log.debug({ removed, size: this.entries.size }, 'swept expired fingerprints');
  }

  private evictOldestIfNeeded(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /**
   * Records an occurrence and reports whether it is new work.
   * Returns `true` when the caller should proceed with healing.
   */
  register(fingerprint: string): { isNew: boolean; hits: number; resolvedBy?: string } {
    const timestamp = this.now();
    const existing = this.entries.get(fingerprint);

    if (existing && timestamp - existing.lastSeenAt <= this.ttlMs) {
      existing.hits += 1;
      existing.lastSeenAt = timestamp;
      return { isNew: false, hits: existing.hits, resolvedBy: existing.resolvedBy };
    }

    this.entries.set(fingerprint, { firstSeenAt: timestamp, lastSeenAt: timestamp, hits: 1 });
    this.evictOldestIfNeeded();

    return { isNew: true, hits: 1 };
  }

  /** Marks a fingerprint as handled (e.g. with the PR url) for observability. */
  markResolved(fingerprint: string, resolvedBy: string): void {
    const entry = this.entries.get(fingerprint);
    if (entry) entry.resolvedBy = resolvedBy;
  }

  /** Releases a fingerprint so a failed attempt can be retried later. */
  forget(fingerprint: string): void {
    this.entries.delete(fingerprint);
  }

  get size(): number {
    return this.entries.size;
  }
}

export const errorCache = new ErrorCache();
