import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

export const APP_ROOT = path.resolve(__dirname, '..', '..');

dotenv.config({ path: path.join(APP_ROOT, '.env') });
// Fall back to a repo-level .env so a single file can configure both apps.
dotenv.config({ path: path.resolve(APP_ROOT, '..', '..', '.env') });

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) => (typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())));

const csv = z
  .string()
  .transform((value) => value.split(',').map((entry) => entry.trim()).filter(Boolean));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: booleanish.default(true),

  WATCH_LOG_FILE: z.string().min(1).default('apps/buggy-backend/logs/error.log'),
  PROCESS_EXISTING_ON_START: booleanish.default(false),
  WATCH_USE_POLLING: booleanish.default(false),
  WATCH_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),

  REPO_ROOT: z.string().min(1).default('.'),
  TARGET_APP_DIR: z.string().min(1).default('apps/buggy-backend'),
  ALLOWED_PATH_PREFIXES: csv.default('apps/buggy-backend/src'),
  MAX_FILES_PER_FIX: z.coerce.number().int().positive().max(10).default(3),

  OPENAI_API_KEY: z.string().default(''),
  OPENAI_MODEL: z.string().min(1).default('gpt-4o-mini'),
  OPENAI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(6000),
  OPENAI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.1),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  OPENAI_MAX_RETRIES: z.coerce.number().int().min(0).max(6).default(3),
  MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.55),

  GITHUB_TOKEN: z.string().default(''),
  GITHUB_OWNER: z.string().default(''),
  GITHUB_REPO: z.string().default(''),
  GIT_BASE_BRANCH: z.string().min(1).default('main'),
  GIT_BRANCH_PREFIX: z.string().min(1).default('autofix'),
  GIT_AUTHOR_NAME: z.string().min(1).default('self-healing-bot'),
  GIT_AUTHOR_EMAIL: z.string().min(1).default('self-healing-bot@users.noreply.github.com'),
  GIT_PUSH_ENABLED: booleanish.default(true),
  PR_LABELS: csv.default('self-healing,automated-fix'),
  PR_DRAFT_ON_VALIDATION_FAILURE: booleanish.default(true),

  DRY_RUN: booleanish.default(false),
  DEDUP_TTL_MS: z.coerce.number().int().positive().default(900_000),
  DEDUP_MAX_ENTRIES: z.coerce.number().int().positive().default(500),
  MAX_HEALS_PER_HOUR: z.coerce.number().int().positive().default(5),
  VALIDATE_TYPECHECK: booleanish.default(true),
  VALIDATE_TESTS: booleanish.default(true),
  VALIDATION_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
  throw new Error(`Invalid environment configuration for self-healing-agent:\n${issues}`);
}

const env = parsed.data;

const absolute = (candidate: string, base: string): string =>
  path.isAbsolute(candidate) ? candidate : path.resolve(base, candidate);

const repoRoot = absolute(env.REPO_ROOT === '.' ? path.resolve(APP_ROOT, '..', '..') : env.REPO_ROOT, process.cwd());

export const config = {
  nodeEnv: env.NODE_ENV,
  dryRun: env.DRY_RUN,
  log: { level: env.LOG_LEVEL, pretty: env.LOG_PRETTY },

  paths: {
    appRoot: APP_ROOT,
    repoRoot,
    logFile: absolute(env.WATCH_LOG_FILE, repoRoot),
    targetAppDir: absolute(env.TARGET_APP_DIR, repoRoot),
    stateDir: path.join(APP_ROOT, '.self-healing'),
  },

  watcher: {
    processExistingOnStart: env.PROCESS_EXISTING_ON_START,
    usePolling: env.WATCH_USE_POLLING,
    pollIntervalMs: env.WATCH_POLL_INTERVAL_MS,
  },

  guardrails: {
    allowedPathPrefixes: env.ALLOWED_PATH_PREFIXES,
    maxFilesPerFix: env.MAX_FILES_PER_FIX,
    maxHealsPerHour: env.MAX_HEALS_PER_HOUR,
    minConfidence: env.MIN_CONFIDENCE,
  },

  openai: {
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL,
    maxOutputTokens: env.OPENAI_MAX_OUTPUT_TOKENS,
    temperature: env.OPENAI_TEMPERATURE,
    timeoutMs: env.OPENAI_TIMEOUT_MS,
    maxRetries: env.OPENAI_MAX_RETRIES,
  },

  dedup: { ttlMs: env.DEDUP_TTL_MS, maxEntries: env.DEDUP_MAX_ENTRIES },

  git: {
    baseBranch: env.GIT_BASE_BRANCH,
    branchPrefix: env.GIT_BRANCH_PREFIX,
    authorName: env.GIT_AUTHOR_NAME,
    authorEmail: env.GIT_AUTHOR_EMAIL,
    pushEnabled: env.GIT_PUSH_ENABLED,
  },

  github: {
    token: env.GITHUB_TOKEN,
    owner: env.GITHUB_OWNER,
    repo: env.GITHUB_REPO,
    labels: env.PR_LABELS,
    draftOnValidationFailure: env.PR_DRAFT_ON_VALIDATION_FAILURE,
  },

  validation: {
    typecheck: env.VALIDATE_TYPECHECK,
    tests: env.VALIDATE_TESTS,
    timeoutMs: env.VALIDATION_TIMEOUT_MS,
  },
} as const;

export type AgentConfig = typeof config;

/** Startup guard: surface missing credentials before any log line is consumed. */
export const assertRuntimeCredentials = (): string[] => {
  const warnings: string[] = [];

  if (!config.openai.apiKey) warnings.push('OPENAI_API_KEY is empty - fix generation will fail.');
  if (!config.dryRun) {
    if (!config.github.token) warnings.push('GITHUB_TOKEN is empty - pull requests cannot be created.');
    if (!config.github.owner || !config.github.repo) warnings.push('GITHUB_OWNER/GITHUB_REPO are empty - pull requests cannot be created.');
  }

  return warnings;
};
