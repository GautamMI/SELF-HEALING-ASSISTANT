import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { createLogger } from '../utils/logger';

const log = createLogger('http');

/** Assigns a correlation id and emits a structured access log per request. */
export const requestContext: RequestHandler = (req, res, next) => {
  req.requestId = (req.header('x-request-id') ?? randomUUID()).slice(0, 64);
  req.startedAt = process.hrtime.bigint();
  res.setHeader('x-request-id', req.requestId);

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - req.startedAt) / 1_000_000;
    log.info(
      {
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Number(durationMs.toFixed(2)),
      },
      `${req.method} ${req.originalUrl} ${res.statusCode}`,
    );
  });

  next();
};
