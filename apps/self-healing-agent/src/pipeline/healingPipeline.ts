import type { Logger } from 'pino';
import { config } from '../config/env';
import { createLogger } from '../utils/logger';
import { SlidingWindowRateLimiter } from '../utils/rateLimiter';
import { errorCache, type ErrorCache } from '../dedup/errorCache';
import { buildCodeContext } from '../context/contextBuilder';
import { fixGenerator, type FixGenerator } from '../ai/fixGenerator';
import { codePatcher, type CodePatcher } from '../patcher/codePatcher';
import { validator, type Validator } from '../validation/validator';
import { gitOps, type GitOps } from '../git/gitOps';
import { githubPullRequestService, type GitHubPullRequestService } from '../git/githubPr';
import type { AppliedPatch, CodeContext, ErrorEvent, FixProposal, HealingOutcome, ValidationReport } from '../types';

const log = createLogger('pipeline');

const MAX_FIX_ATTEMPTS = 2;

export interface HealingPipelineDeps {
  cache?: ErrorCache;
  generator?: FixGenerator;
  patcher?: CodePatcher;
  codeValidator?: Validator;
  git?: GitOps;
  github?: GitHubPullRequestService;
}

/**
 * End-to-end orchestration:
 *
 *   dedup → context → AI fix → patch → validate → branch/commit/push → PR
 *
 * Every failure path rolls the working tree back and returns the original
 * branch, so a bad run leaves the repository exactly as it was found.
 */
export class HealingPipeline {
  private readonly cache: ErrorCache;
  private readonly generator: FixGenerator;
  private readonly patcher: CodePatcher;
  private readonly validator: Validator;
  private readonly git: GitOps;
  private readonly github: GitHubPullRequestService;
  private readonly rateLimiter: SlidingWindowRateLimiter;

  constructor(deps: HealingPipelineDeps = {}) {
    this.cache = deps.cache ?? errorCache;
    this.generator = deps.generator ?? fixGenerator;
    this.patcher = deps.patcher ?? codePatcher;
    this.validator = deps.codeValidator ?? validator;
    this.git = deps.git ?? gitOps;
    this.github = deps.github ?? githubPullRequestService;
    this.rateLimiter = new SlidingWindowRateLimiter(config.guardrails.maxHealsPerHour);
  }

  async handle(event: ErrorEvent): Promise<HealingOutcome> {
    const eventLog = log.child({ fingerprint: event.fingerprint, errorType: event.errorType });

    const seen = this.cache.register(event.fingerprint);
    if (!seen.isNew) {
      eventLog.info({ hits: seen.hits, resolvedBy: seen.resolvedBy }, 'duplicate error suppressed');
      return { status: 'skipped', reason: `duplicate (${seen.hits} occurrences in TTL window)`, event };
    }

    if (!this.rateLimiter.tryAcquire()) {
      eventLog.warn({ limit: config.guardrails.maxHealsPerHour }, 'hourly healing budget exhausted');
      this.cache.forget(event.fingerprint);
      return { status: 'skipped', reason: 'hourly heal limit reached', event };
    }

    eventLog.info({ message: event.message, source: event.source?.file }, 'starting healing run');

    let context: CodeContext;
    try {
      context = await buildCodeContext(event);
    } catch (error) {
      eventLog.error({ error: (error as Error).message }, 'could not build code context');
      return { status: 'failed', reason: (error as Error).message, event, error: error as Error };
    }

    return this.runFixLoop(event, context, eventLog);
  }

  private async runFixLoop(
    event: ErrorEvent,
    context: CodeContext,
    eventLog: Logger,
  ): Promise<HealingOutcome> {
    let previousFailure: string | undefined;

    for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt += 1) {
      let proposal: FixProposal;

      try {
        proposal = await this.generator.generate(context, previousFailure);
      } catch (error) {
        eventLog.error({ attempt, error: (error as Error).message }, 'fix generation failed');
        this.cache.forget(event.fingerprint);
        return { status: 'failed', reason: (error as Error).message, event, error: error as Error };
      }

      let patch: AppliedPatch;
      try {
        patch = await this.patcher.apply(proposal);
      } catch (error) {
        eventLog.error({ attempt, error: (error as Error).message }, 'patch application failed');
        this.cache.forget(event.fingerprint);
        return { status: 'failed', reason: (error as Error).message, event, error: error as Error };
      }

      const validation = await this.validator.validate();

      if (!validation.ok) {
        const failureOutput = validation.results.filter((result) => !result.ok).map((result) => result.output).join('\n');
        await this.patcher.rollback(patch);
        eventLog.warn({ attempt }, 'validation gate failed; rolled back');

        if (attempt < MAX_FIX_ATTEMPTS) {
          previousFailure = failureOutput;
          continue;
        }

        this.cache.forget(event.fingerprint);
        return { status: 'failed', reason: 'patch did not pass the blocking validation gate', event };
      }

      if (config.dryRun) {
        eventLog.info({ files: patch.files.map((file) => file.path) }, 'DRY_RUN: patch kept locally, no commit or PR');
        return { status: 'dry-run', event, proposal, diff: patch.unifiedDiff };
      }

      return this.publish(event, proposal, patch, validation, eventLog);
    }

    this.cache.forget(event.fingerprint);
    return { status: 'failed', reason: 'exhausted fix attempts', event };
  }

  private async publish(
    event: ErrorEvent,
    proposal: FixProposal,
    patch: AppliedPatch,
    validation: ValidationReport,
    eventLog: Logger,
  ): Promise<HealingOutcome> {
    const branch = this.git.buildBranchName(event);
    const files = patch.files.map((file) => file.path);
    let previousBranch: string | undefined;

    try {
      previousBranch = await this.git.createFixBranch(branch);
      const commitHash = await this.git.commit(files, this.git.buildCommitMessage(event, proposal));
      await this.git.push(branch);

      const pullRequest = await this.github.createPullRequest({ event, proposal, patch, validation, branch, commitHash });

      this.cache.markResolved(event.fingerprint, pullRequest.url);
      eventLog.info({ pr: pullRequest.number, url: pullRequest.url, draft: pullRequest.draft }, '✅ healing run complete');

      return { status: 'healed', event, proposal, pullRequest, validation };
    } catch (error) {
      eventLog.error({ error: (error as Error).message }, 'publish step failed; restoring working tree');

      await this.patcher.rollback(patch);
      await this.git.restore(files);
      this.cache.forget(event.fingerprint);

      return { status: 'failed', reason: (error as Error).message, event, error: error as Error };
    } finally {
      if (previousBranch) {
        // Always return the developer to the branch they were on.
        await this.git.checkout(previousBranch).catch((error: Error) => {
          eventLog.warn({ error: error.message, previousBranch }, 'could not switch back to the original branch');
        });
      }
    }
  }
}

export const healingPipeline = new HealingPipeline();
