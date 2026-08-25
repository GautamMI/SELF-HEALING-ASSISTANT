import 'source-map-support/register';
import express from 'express';
import { config } from './config/env';
import { cartRouter } from './routes/cart.routes';
import { internalRouter } from './routes/internal.routes';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { requestContext } from './middleware/requestContext';
import { createLogger, ERROR_LOG_PATH, logger } from './utils/logger';
import { logError } from './utils/errorReporter';

const log = createLogger('bootstrap');

export const createApp = (): express.Express => {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use(requestContext);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: config.serviceName, uptimeSeconds: Math.round(process.uptime()) });
  });

  app.use('/api/cart', cartRouter);
  app.use('/internal', internalRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};

const start = (): void => {
  const app = createApp();

  const server = app.listen(config.port, () => {
    log.info({ port: config.port, errorLog: ERROR_LOG_PATH }, `buggy-backend listening on :${config.port}`);
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    log.info({ signal }, 'shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  (['SIGINT', 'SIGTERM'] as NodeJS.Signals[]).forEach((signal) => process.on(signal, () => shutdown(signal)));

  // Last-resort safety nets: an unhandled failure must still reach error.log
  // with a resolved source location before the process dies.
  process.on('unhandledRejection', (reason) => {
    logError(log, reason, { operation: 'process.unhandledRejection' });
  });

  process.on('uncaughtException', (error) => {
    logError(log, error, { operation: 'process.uncaughtException' });
    logger.flush?.();
    setTimeout(() => process.exit(1), 250).unref();
  });
};

if (require.main === module) {
  start();
}
