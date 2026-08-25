import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino, { type Logger, type StreamEntry } from 'pino';
import { config } from '../config/env';

fs.mkdirSync(config.log.dir, { recursive: true });

/** Absolute path of the file the self-healing agent tails. */
export const ERROR_LOG_PATH = path.join(config.log.dir, config.log.file);

/**
 * Two sinks:
 *  - `error.log`  : newline-delimited JSON, level >= error. This is the machine
 *                   contract consumed by Application 2, so it is *never* pretty
 *                   printed and never truncated.
 *  - stdout       : human readable during development, JSON in production.
 */
const buildStreams = (): StreamEntry[] => {
  const fileStream = pino.destination({ dest: ERROR_LOG_PATH, mkdir: true, sync: false });

  const consoleStream = config.log.pretty
    ? pino.transport({
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
      })
    : pino.destination({ fd: 1, sync: false });

  return [
    { level: 'error', stream: fileStream },
    { level: config.log.level, stream: consoleStream },
  ];
};

export const logger: Logger = pino(
  {
    level: 'trace', // per-stream levels do the real filtering
    base: { service: config.serviceName, env: config.nodeEnv, hostname: os.hostname(), pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    serializers: {
      err: pino.stdSerializers.err,
    },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token', '*.apiKey'],
      censor: '[REDACTED]',
    },
  },
  pino.multistream(buildStreams(), { dedupe: false }),
);

/** Child logger helper so every module tags its own component name. */
export const createLogger = (component: string, bindings: Record<string, unknown> = {}): Logger =>
  logger.child({ component, ...bindings });
