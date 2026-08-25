/**
 * Deterministic environment for unit tests: no real credentials, no network,
 * and no dependency on whatever .env happens to sit on the developer's machine.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.LOG_PRETTY = 'false';
process.env.DRY_RUN = 'true';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? 'test-key';
process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? 'test-token';
process.env.GITHUB_OWNER = process.env.GITHUB_OWNER ?? 'test-owner';
process.env.GITHUB_REPO = process.env.GITHUB_REPO ?? 'test-repo';
