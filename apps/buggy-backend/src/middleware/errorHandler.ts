import type { ErrorRequestHandler, RequestHandler } from 'express';
import { config } from '../config/env';
import { createLogger } from '../utils/logger';
import { logError } from '../utils/errorReporter';

const log = createLogger('error-handler');

/** 404 handler - converted into an error so there is exactly one response shape. */
export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { type: 'NotFound', message: `Route ${req.method} ${req.originalUrl} does not exist`, requestId: req.requestId },
  });
};

/**
 * Terminal error middleware.
 *
 * Responsibilities, in order:
 *  1. Persist a machine-readable error envelope (this feeds the healing agent).
 *  2. Return a safe, stable JSON error contract to the caller.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const error = err instanceof Error ? err : new Error(String(err));

  const { errorSource } = logError(log, error, {
    route: `${req.method} ${req.route?.path ?? req.originalUrl}`,
    requestId: req.requestId,
    operation: 'http.request',
    input: { params: req.params, query: req.query, body: req.body },
  });

  if (res.headersSent) {
    res.end();
    return;
  }

  res.status(500).json({
    error: {
      type: error.name,
      message: error.message,
      requestId: req.requestId,
      source: config.isProduction ? undefined : errorSource,
    },
  });
};
