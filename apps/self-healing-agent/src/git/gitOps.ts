import simpleGit, { type SimpleGit } from 'simple-git';
import { config } from '../config/env';
import { createLogger } from '../utils/logger';
import type { ErrorEvent, FixProposal } from '../types';

const log = createLogger('git-ops');

export class GitOperationError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'GitOperationError';
  }
}

export interface CommitResult {
  branch: string;
  commitHash: string;
  pushed: boolean;
}

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'error';

export class GitOps {
  private readonly git: SimpleGit;

  constructor(repoRoot: string = config.paths.repoRoot) {
    this.git = simpleGit({ baseDir: repoRoot, maxConcurrentProcesses: 1 });
  }

  async assertRepository(): Promise<void> {
    if (!(await this.git.checkIsRepo())) {
      throw new GitOperationError(`${config.paths.repoRoot} is not a git repository. Run "git init" first.`);
    }
  }

  /** `autofix/typeerror-cannot-read-properties-<fingerprint>` */
  buildBranchName(event: ErrorEvent): string {
    return `${config.git.branchPrefix}/${slugify(`${event.errorType}-${event.message}`)}-${event.fingerprint.slice(0, 8)}`;
  }

  /**
   * Conventional-commit message with a machine-readable trailer so a human can
   * trace any commit back to the exact log event that triggered it.
   */
  buildCommitMessage(event: ErrorEvent, proposal: FixProposal): string {
    const scope = event.source?.file?.split('/').pop()?.replace(/\.ts$/, '') ?? 'app';

    return [
      `fix(${scope}): ${proposal.summary}`,
      '',
      `Root cause: ${proposal.rootCause}`,
      '',
      `Detected error : ${event.errorType}: ${event.message}`,
      `Source         : ${event.source?.file ?? 'unknown'}:${event.source?.line ?? '?'} (${event.source?.function ?? 'unknown'})`,
      `Fingerprint    : ${event.fingerprint}`,
      `Model          : ${proposal.model} (confidence ${proposal.confidence.toFixed(2)}, risk ${proposal.riskLevel})`,
      '',
      'Generated automatically by the self-healing assistant. Human review required.',
    ].join('\n');
  }

  private async currentBranch(): Promise<string> {
    return (await this.git.revparse(['--abbrev-ref', 'HEAD'])).trim();
  }

  /**
   * Creates the fix branch from the configured base branch.
   * Uses `-B` semantics so a re-run reuses the branch instead of exploding.
   */
  async createFixBranch(branchName: string): Promise<string> {
    await this.assertRepository();

    const previousBranch = await this.currentBranch();
    const branches = await this.git.branchLocal();
    const startPoint = branches.all.includes(config.git.baseBranch) ? config.git.baseBranch : previousBranch;

    await this.git.checkout(['-B', branchName, startPoint]);
    log.info({ branch: branchName, startPoint }, 'created fix branch');

    return previousBranch;
  }

  /** Stages only the files we patched - never `git add .`. */
  async commit(files: string[], message: string): Promise<string> {
    await this.git.addConfig('user.name', config.git.authorName, false, 'local');
    await this.git.addConfig('user.email', config.git.authorEmail, false, 'local');

    await this.git.add(files);

    const status = await this.git.status();
    if (status.staged.length === 0) throw new GitOperationError('Nothing staged - refusing to create an empty commit');

    const result = await this.git.commit(message, files);
    log.info({ commit: result.commit, files }, 'committed fix');

    return result.commit;
  }

  /**
   * Pushes the branch. The token is injected into the remote URL for this
   * single invocation only, never written to `.git/config`.
   */
  async push(branchName: string): Promise<boolean> {
    if (!config.git.pushEnabled) {
      log.warn({ branch: branchName }, 'push disabled by configuration');
      return false;
    }

    const remotes = await this.git.getRemotes(true);
    const origin = remotes.find((remote) => remote.name === 'origin');
    if (!origin) throw new GitOperationError('No "origin" remote configured');

    if (config.github.token && config.github.owner && config.github.repo) {
      const authedUrl = `https://x-access-token:${config.github.token}@github.com/${config.github.owner}/${config.github.repo}.git`;
      await this.git.push(authedUrl, `${branchName}:${branchName}`, ['--set-upstream']);
    } else {
      await this.git.push('origin', branchName, ['--set-upstream']);
    }

    log.info({ branch: branchName }, 'pushed fix branch');
    return true;
  }

  async checkout(branchName: string): Promise<void> {
    await this.git.checkout(branchName);
  }

  /** Discards working-tree changes for the given paths (used on rollback). */
  async restore(files: string[]): Promise<void> {
    if (files.length === 0) return;
    try {
      await this.git.checkout(['--', ...files]);
    } catch (error) {
      log.warn({ error: (error as Error).message }, 'git restore failed');
    }
  }

  async isWorkingTreeClean(): Promise<boolean> {
    return (await this.git.status()).isClean();
  }
}

export const gitOps = new GitOps();
