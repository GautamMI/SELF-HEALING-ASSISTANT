import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

/**
 * Application root (…/apps/buggy-backend). Resolved from this file so it is
 * correct whether we run from `src` (ts-node-dev) or `dist` (compiled).
 */
export const APP_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Monorepo root (…/self-healing-assistant). Error logs record file paths
 * relative to this root so that the self-healing agent can resolve them
 * unambiguously from its own working directory.
 */
export const REPO_ROOT = path.resolve(APP_ROOT, '..', '..');

dotenv.config({ path: path.join(APP_ROOT, '.env') });

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) => (typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  SERVICE_NAME: z.string().min(1).default('buggy-backend'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('debug'),
  LOG_DIR: z.string().min(1).default('logs'),
  LOG_FILE: z.string().min(1).default('error.log'),
  LOG_PRETTY: booleanish.default(true),

  PRICING_API_URL: z.string().url().default('http://localhost:4000/internal/pricing-feed'),
  PRICING_API_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  // Fail fast and loudly: a mis-configured service must never boot half-alive.
  const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
  throw new Error(`Invalid environment configuration for buggy-backend:\n${issues}`);
}

const env = parsed.data;

export const config = {
  nodeEnv: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  port: env.PORT,
  serviceName: env.SERVICE_NAME,
  appRoot: APP_ROOT,
  repoRoot: REPO_ROOT,
  log: {
    level: env.LOG_LEVEL,
    dir: path.isAbsolute(env.LOG_DIR) ? env.LOG_DIR : path.join(APP_ROOT, env.LOG_DIR),
    file: env.LOG_FILE,
    pretty: env.LOG_PRETTY,
  },
  pricing: {
    url: env.PRICING_API_URL,
    timeoutMs: env.PRICING_API_TIMEOUT_MS,
  },
} as const;

export type AppConfig = typeof config;
