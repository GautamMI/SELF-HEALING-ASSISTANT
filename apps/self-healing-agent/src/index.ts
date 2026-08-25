import { config, assertRuntimeCredentials } from './config/env';
import { createLogger, logger } from './utils/logger';
import { AsyncQueue } from './utils/asyncQueue';
import { LogWatcher } from './watcher/logWatcher';
import { parseLogLine } from './parser/errorParser';
import { errorCache } from './dedup/errorCache';
import { healingPipeline } from './pipeline/healingPipeline';
import { gitOps } from './git/gitOps';

const log = createLogger('main');

/**
 * Entry point.
 *
 * The watcher is intentionally decoupled from the pipeline by a serial queue:
 * log lines arrive in bursts, but healing runs mutate the git working tree and
 * therefore must execute strictly one at a time.
 */
const bootstrap = async (): Promise<void> => {
  const runOnce = process.argv.includes('--once');

  log.info(
    {
      logFile: config.paths.logFile,
      repoRoot: config.paths.repoRoot,
      targetApp: config.paths.targetAppDir,
      model: config.openai.model,
      dryRun: config.dryRun,
      allowedPaths: config.guardrails.allowedPathPrefixes,
      maxHealsPerHour: config.guardrails.maxHealsPerHour,
    },
    'self-healing agent starting',
  );

  for (const warning of assertRuntimeCredentials()) log.warn(warning);

  if (!config.dryRun) {
    await gitOps.assertRepository();
    if (!(await gitOps.isWorkingTreeClean())) {
      log.warn('working tree is dirty - commit or stash your changes so automated commits stay isolated');
    }
  }

  errorCache.startSweeper();

  const queue = new AsyncQueue();
  const watcher = new LogWatcher();

  watcher.on('error', (error) => log.error({ error: error.message }, 'watcher error'));

  watcher.on('line', (line) => {
    const event = parseLogLine(line);
    if (!event) return;

    log.info({ errorType: event.errorType, fingerprint: event.fingerprint, source: event.source?.file }, '🚨 error detected');

    void queue
      .push(() => healingPipeline.handle(event))
      .then(async (outcome) => {
        log.info({ status: outcome.status, queued: queue.size }, 'healing outcome');
        if (runOnce && outcome.status !== 'skipped') await shutdown('SIGTERM');
      })
      .catch((error: Error) => log.error({ error: error.message }, 'unhandled pipeline failure'));
  });

  await watcher.start();
  log.info(runOnce ? 'agent ready (single-shot mode)' : 'agent ready - waiting for errors');

  let shuttingDown = false;

  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info({ signal, inFlight: queue.size }, 'shutting down - draining in-flight healing runs');

    await watcher.stop();
    await queue.drain();
    errorCache.stopSweeper();

    log.info('shutdown complete');
    process.exit(0);
  }

  (['SIGINT', 'SIGTERM'] as NodeJS.Signals[]).forEach((signal) => process.on(signal, () => void shutdown(signal)));

  process.on('unhandledRejection', (reason) => log.error({ reason: String(reason) }, 'unhandled rejection'));
  process.on('uncaughtException', (error) => {
    log.fatal({ error: error.message, stack: error.stack }, 'uncaught exception - exiting');
    logger.flush?.();
    setTimeout(() => process.exit(1), 250).unref();
  });
};

void bootstrap().catch((error: Error) => {
  log.fatal({ error: error.message, stack: error.stack }, 'failed to start self-healing agent');
  process.exit(1);
});
