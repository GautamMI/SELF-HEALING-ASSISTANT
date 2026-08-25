import type { Logger } from 'pino';
import { resolveErrorSource } from './stackParser';
import type { ErrorSource } from '../types';

export interface ErrorLogContext {
  /** e.g. `POST /api/cart/checkout` */
  route?: string;
  requestId?: string;
  operation?: string;
  /** Small, already-redacted payload snapshot that helps reproduce the failure. */
  input?: unknown;
  [key: string]: unknown;
}

export interface LoggedErrorEnvelope {
  msg: string;
  errorSource?: ErrorSource;
  context: ErrorLogContext;
}

const toError = (thrown: unknown): Error =>
  thrown instanceof Error ? thrown : new Error(typeof thrown === 'string' ? thrown : JSON.stringify(thrown));

/**
 * Single choke point for error logging.
 *
 * Every error written to `error.log` carries `errorSource` (file + function +
 * line) alongside the stack. That contract is what allows Application 2 to skip
 * fuzzy stack scraping and go straight to the offending file.
 */
export const logError = (log: Logger, thrown: unknown, context: ErrorLogContext = {}): LoggedErrorEnvelope => {
  const error = toError(thrown);
  const errorSource = resolveErrorSource(error);

  const envelope: LoggedErrorEnvelope = {
    msg: error.message,
    errorSource,
    context,
  };

  log.error(
    {
      err: error,
      errorSource,
      errorType: error.name,
      context,
      // Flattened duplicates keep the log greppable for humans and cheap to
      // parse for the agent, without needing a JSONPath expression.
      sourceFile: errorSource?.file,
      sourceFunction: errorSource?.function,
      sourceLine: errorSource?.line,
    },
    error.message,
  );

  return envelope;
};
