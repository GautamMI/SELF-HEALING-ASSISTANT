import { ErrorCache } from '../src/dedup/errorCache';

describe('ErrorCache', () => {
  let now = 1_000_000;
  const clock = (): number => now;

  beforeEach(() => {
    now = 1_000_000;
  });

  it('treats the first occurrence as new and repeats as duplicates', () => {
    const cache = new ErrorCache(60_000, 100, clock);

    expect(cache.register('abc').isNew).toBe(true);
    expect(cache.register('abc')).toMatchObject({ isNew: false, hits: 2 });
  });

  it('lets a fingerprint through again once the TTL elapses', () => {
    const cache = new ErrorCache(60_000, 100, clock);

    cache.register('abc');
    now += 60_001;

    expect(cache.register('abc').isNew).toBe(true);
  });

  it('exposes the resolution reference on duplicates', () => {
    const cache = new ErrorCache(60_000, 100, clock);

    cache.register('abc');
    cache.markResolved('abc', 'https://github.com/org/repo/pull/7');

    expect(cache.register('abc').resolvedBy).toBe('https://github.com/org/repo/pull/7');
  });

  it('allows a retry after forget()', () => {
    const cache = new ErrorCache(60_000, 100, clock);

    cache.register('abc');
    cache.forget('abc');

    expect(cache.register('abc').isNew).toBe(true);
  });

  it('evicts the oldest entries beyond the size cap', () => {
    const cache = new ErrorCache(60_000, 2, clock);

    cache.register('a');
    cache.register('b');
    cache.register('c');

    expect(cache.size).toBe(2);
  });
});
