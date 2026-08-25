import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createLogger } from '../utils/logger';
import type { ErrorEvent, ErrorSource } from '../types';

const log = createLogger('error-parser');

const ErrorSourceSchema = z.object({
  file: z.string().min(1),
  absolutePath: z.string().optional(),
  function: z.string().default('<anonymous>'),
  line: z.coerce.number().int().nonnegative().default(0),
  column: z.coerce.number().int().nonnegative().optional(),
});

const LogLineSchema = z.object({
  level: z.union([z.string(), z.number()]).optional(),
  time: z.union([z.string(), z.number()]).optional(),
  service: z.string().optional(),
  component: z.string().optional(),
  msg: z.string().optional(),
  errorType: z.string().optional(),
  err: z
    .object({
      type: z.string().optional(),
      message: z.string().optional(),
      stack: z.string().optional(),
    })
    .optional(),
  errorSource: ErrorSourceSchema.optional(),
  context: z.record(z.unknown()).optional(),
});

const ERROR_LEVELS = new Set(['error', 'fatal']);
const NUMERIC_ERROR_LEVEL = 50; // pino: error=50, fatal=60

const isErrorLevel = (level: unknown): boolean => {
  if (typeof level === 'number') return level >= NUMERIC_ERROR_LEVEL;
  if (typeof level === 'string') {
    if (ERROR_LEVELS.has(level.toLowerCase())) return true;
    const numeric = Number(level);
    return Number.isFinite(numeric) && numeric >= NUMERIC_ERROR_LEVEL;
  }
  return false;
};

const toIsoTimestamp = (time: unknown): string => {
  if (typeof time === 'number') return new Date(time).toISOString();
  if (typeof time === 'string') {
    const parsed = Date.parse(time);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
};

/**
 * Fingerprint = errorType + normalised message + source location.
 *
 * Messages are normalised (digits, uuids, quoted values collapsed) so that the
 * same defect hit by 200 different carts produces one fingerprint - and
 * therefore one pull request - rather than 200.
 */
export const fingerprintError = (errorType: string, message: string, source?: ErrorSource): string => {
  const normalisedMessage = message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/["'`][^"'`]{0,80}["'`]/g, '<str>')
    .trim()
    .toLowerCase();

  const locus = source ? `${source.file}:${source.function}` : 'unknown';

  return createHash('sha1').update(`${errorType}|${normalisedMessage}|${locus}`).digest('hex').slice(0, 16);
};

/**
 * Converts one raw log line into an `ErrorEvent`.
 * Returns `null` for anything that is not a parseable error record - malformed
 * lines must never take the agent down.
 */
export const parseLogLine = (raw: string): ErrorEvent | null => {
  let json: unknown;

  try {
    json = JSON.parse(raw);
  } catch {
    log.debug({ preview: raw.slice(0, 160) }, 'skipping non-JSON log line');
    return null;
  }

  const parsed = LogLineSchema.safeParse(json);
  if (!parsed.success) {
    log.debug({ issues: parsed.error.issues.length }, 'skipping log line with unexpected shape');
    return null;
  }

  const record = parsed.data;
  if (!isErrorLevel(record.level)) return null;

  const errorType = record.err?.type ?? record.errorType ?? 'Error';
  const message = record.err?.message ?? record.msg ?? 'Unknown error';
  const source = record.errorSource;

  return {
    fingerprint: fingerprintError(errorType, message, source),
    timestamp: toIsoTimestamp(record.time),
    service: record.service ?? 'unknown-service',
    component: record.component,
    errorType,
    message,
    stack: record.err?.stack,
    source,
    context: record.context ?? {},
    raw,
  };
};
