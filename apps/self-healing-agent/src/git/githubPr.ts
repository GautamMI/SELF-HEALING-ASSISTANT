import { Octokit } from '@octokit/rest';
import { config } from '../config/env';
import { createLogger } from '../utils/logger';
import type { AppliedPatch, ErrorEvent, FixProposal, PullRequestResult, ValidationReport } from '../types';

const log = createLogger('github-pr');

export class PullRequestError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'PullRequestError';
  }
}

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max)}\n… truncated (${value.length - max} more characters)`;

const renderValidation = (report: ValidationReport): string => {
  if (report.skipped) return '_Validation was disabled for this run._';

  return report.results
    .map((result) => `| \`${result.command}\` | ${result.ok ? '✅ pass' : '❌ fail'} | ${result.exitCode ?? 'n/a'} | ${result.durationMs} ms |`)
    .join('\n');
};

export interface PullRequestInput {
  event: ErrorEvent;
  proposal: FixProposal;
  patch: AppliedPatch;
  validation: ValidationReport;
  branch: string;
  commitHash: string;
}

export class GitHubPullRequestService {
  private readonly octokit: Octokit;

  constructor(octokit?: Octokit) {
    this.octokit = octokit ?? new Octokit({ auth: config.github.token, userAgent: 'self-healing-assistant/1.0.0' });
  }

  private assertConfigured(): void {
    if (!config.github.token) throw new PullRequestError('GITHUB_TOKEN is not configured');
    if (!config.github.owner || !config.github.repo) throw new PullRequestError('GITHUB_OWNER/GITHUB_REPO are not configured');
  }

  buildTitle(proposal: FixProposal, event: ErrorEvent): string {
    return `fix: ${proposal.summary} [${event.errorType}]`.slice(0, 120);
  }

  buildBody(input: PullRequestInput): string {
    const { event, proposal, patch, validation, commitHash } = input;
    const testsFailed = validation.results.some((result) => result.command.includes('test') && !result.ok);

    return `## 🤖 Automated fix

This pull request was opened by the **self-healing assistant** after it observed a failure in \`${event.service}\`.
**A human must review and approve it before merge.**

### Detected error

| | |
|---|---|
| Type | \`${event.errorType}\` |
| Message | ${event.message} |
| Source | \`${event.source?.file ?? 'unknown'}:${event.source?.line ?? '?'}\` in \`${event.source?.function ?? 'unknown'}\` |
| First seen | ${event.timestamp} |
| Fingerprint | \`${event.fingerprint}\` |

### Root cause

${proposal.rootCause}

### Fix

${proposal.changes.map((change) => `- \`${change.path}\` — ${change.rationale}`).join('\n')}

| Model | Confidence | Risk |
|---|---|---|
| \`${proposal.model}\` | ${proposal.confidence.toFixed(2)} | ${proposal.riskLevel} |

### Validation

| Command | Result | Exit code | Duration |
|---|---|---|---|
${renderValidation(validation)}

${testsFailed ? '> ⚠️ The test suite is still red. Opened as a draft for human triage.' : ''}

### How to verify

${proposal.testNotes ?? 'Re-run the failing scenario against the patched branch.'}

<details>
<summary>Unified diff</summary>

\`\`\`diff
${truncate(patch.unifiedDiff, 40_000)}
\`\`\`

</details>

<details>
<summary>Original log line</summary>

\`\`\`json
${truncate(event.raw, 6000)}
\`\`\`

</details>

<sub>Commit \`${commitHash.slice(0, 8)}\` · generated at ${new Date().toISOString()}</sub>`;
  }

  /** Reuses an existing open PR for the branch rather than failing on 422. */
  private async findExistingPullRequest(branch: string): Promise<PullRequestResult | null> {
    const { data } = await this.octokit.pulls.list({
      owner: config.github.owner,
      repo: config.github.repo,
      head: `${config.github.owner}:${branch}`,
      state: 'open',
      per_page: 1,
    });

    const existing = data[0];
    return existing ? { number: existing.number, url: existing.html_url, branch, draft: Boolean(existing.draft) } : null;
  }

  async createPullRequest(input: PullRequestInput): Promise<PullRequestResult> {
    this.assertConfigured();

    const { branch, proposal, event, validation } = input;
    const testsFailed = validation.results.some((result) => result.command.includes('test') && !result.ok);
    const lowConfidence = proposal.confidence < config.guardrails.minConfidence;
    const draft = config.github.draftOnValidationFailure && (testsFailed || lowConfidence);

    const existing = await this.findExistingPullRequest(branch);
    if (existing) {
      log.info({ pr: existing.number }, 'reusing existing open pull request for branch');
      await this.updateBody(existing.number, this.buildBody(input));
      return existing;
    }

    try {
      const { data } = await this.octokit.pulls.create({
        owner: config.github.owner,
        repo: config.github.repo,
        head: branch,
        base: config.git.baseBranch,
        title: this.buildTitle(proposal, event),
        body: this.buildBody(input),
        draft,
        maintainer_can_modify: true,
      });

      await this.applyLabels(data.number);

      log.info({ pr: data.number, url: data.html_url, draft }, 'pull request created');

      return { number: data.number, url: data.html_url, branch, draft };
    } catch (error) {
      throw new PullRequestError(`Failed to create pull request: ${(error as Error).message}`, error);
    }
  }

  private async updateBody(pullNumber: number, body: string): Promise<void> {
    await this.octokit.pulls.update({ owner: config.github.owner, repo: config.github.repo, pull_number: pullNumber, body });
  }

  /** Labels are cosmetic - never fail a healing run because a label is missing. */
  private async applyLabels(issueNumber: number): Promise<void> {
    if (config.github.labels.length === 0) return;

    try {
      await this.octokit.issues.addLabels({
        owner: config.github.owner,
        repo: config.github.repo,
        issue_number: issueNumber,
        labels: [...config.github.labels],
      });
    } catch (error) {
      log.warn({ error: (error as Error).message }, 'could not apply labels');
    }
  }
}

export const githubPullRequestService = new GitHubPullRequestService();
