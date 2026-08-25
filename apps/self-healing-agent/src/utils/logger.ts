import pino, { type Logger } from 'pino';
import { config } from '../config/env';

export const logger: Logger = pino({
  level: config.log.level,
  base: { service: 'self-healing-agent' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ['config.openai.apiKey', 'config.github.token', '*.apiKey', '*.token', 'headers.authorization'],
    censor: '[REDACTED]',
  },
  ...(config.log.pretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,service' },
        },
      }
    : {}),
});

export const createLogger = (component: string, bindings: Record<string, unknown> = {}): Logger =>
  logger.child({ component, ...bindings });
