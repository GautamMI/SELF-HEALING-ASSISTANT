import { fingerprintError, parseLogLine } from '../src/parser/errorParser';

const buildLine = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    level: 'error',
    time: '2026-01-01T10:00:00.000Z',
    service: 'buggy-backend',
    component: 'error-handler',
    errorType: 'TypeError',
    err: {
      type: 'TypeError',
      message: "Cannot read properties of undefined (reading 'discount')",
      stack: "TypeError: boom\n    at CartService.applyCoupon (/repo/apps/buggy-backend/src/services/cart.service.ts:88:41)",
    },
    errorSource: {
      file: 'apps/buggy-backend/src/services/cart.service.ts',
      function: 'CartService.applyCoupon',
      line: 88,
      column: 41,
    },
    context: { route: 'POST /api/cart/checkout' },
    msg: 'Cannot read properties of undefined',
    ...overrides,
  });

describe('parseLogLine', () => {
  it('normalises a pino error record into an ErrorEvent', () => {
    const event = parseLogLine(buildLine());

    expect(event).not.toBeNull();
    expect(event?.errorType).toBe('TypeError');
    expect(event?.source?.file).toBe('apps/buggy-backend/src/services/cart.service.ts');
    expect(event?.source?.line).toBe(88);
    expect(event?.fingerprint).toHaveLength(16);
  });

  it('ignores non-error levels', () => {
    expect(parseLogLine(buildLine({ level: 'info' }))).toBeNull();
    expect(parseLogLine(buildLine({ level: 30 }))).toBeNull();
  });

  it('accepts numeric pino levels', () => {
    expect(parseLogLine(buildLine({ level: 50 }))).not.toBeNull();
  });

  it('never throws on malformed input', () => {
    expect(parseLogLine('not json at all')).toBeNull();
    expect(parseLogLine('{"partial":')).toBeNull();
  });
});

describe('fingerprintError', () => {
  const source = { file: 'a/b.ts', function: 'fn', line: 10 };

  it('collapses variable data so repeats share a fingerprint', () => {
    const first = fingerprintError('TypeError', 'Cart 1001 is invalid', source);
    const second = fingerprintError('TypeError', 'Cart 2044 is invalid', source);

    expect(first).toBe(second);
  });

  it('separates different error types', () => {
    expect(fingerprintError('TypeError', 'boom', source)).not.toBe(fingerprintError('RangeError', 'boom', source));
  });
});
