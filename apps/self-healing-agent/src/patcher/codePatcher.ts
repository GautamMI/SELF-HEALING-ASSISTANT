import fs from 'node:fs/promises';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { createLogger } from '../utils/logger';
import { assertPathAllowed, toAbsolute } from '../utils/paths';
import type { AppliedPatch, FixProposal } from '../types';

const log = createLogger('code-patcher');

export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchError';
  }
}

/**
 * Writes an AI proposal to disk transactionally-ish:
 *  - every target path is re-validated against the allow-list,
 *  - the previous content of each file is captured in memory first,
 *  - a failure mid-way triggers an immediate rollback,
 *  - a unified diff is produced for the pull request body.
 */
export class CodePatcher {
  async apply(proposal: FixProposal): Promise<AppliedPatch> {
    const applied: AppliedPatch['files'] = [];
    const diffs: string[] = [];

    try {
      for (const change of proposal.changes) {
        const repoRelative = assertPathAllowed(change.path);
        const absolutePath = toAbsolute(repoRelative);

        const previousContent = await fs.readFile(absolutePath, 'utf8');
        if (previousContent === change.updatedContent) {
          log.warn({ file: repoRelative }, 'proposed content is identical to disk; skipping');
          continue;
        }

        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, change.updatedContent, 'utf8');

        applied.push({ path: repoRelative, absolutePath, previousContent });
        diffs.push(
          createTwoFilesPatch(`a/${repoRelative}`, `b/${repoRelative}`, previousContent, change.updatedContent, '', '', {
            context: 4,
          }),
        );

        log.info({ file: repoRelative, bytes: change.updatedContent.length }, 'patched file');
      }

      if (applied.length === 0) throw new PatchError('No files were modified by the proposal');

      return { files: applied, unifiedDiff: diffs.join('\n') };
    } catch (error) {
      await this.rollback({ files: applied, unifiedDiff: '' });
      throw error instanceof PatchError ? error : new PatchError(`Failed to apply patch: ${(error as Error).message}`);
    }
  }

  /** Restores every file captured by `apply`. Best-effort and always logged. */
  async rollback(patch: AppliedPatch): Promise<void> {
    for (const file of patch.files) {
      try {
        await fs.writeFile(file.absolutePath, file.previousContent, 'utf8');
        log.info({ file: file.path }, 'rolled back file');
      } catch (error) {
        log.error({ file: file.path, error: (error as Error).message }, 'rollback failed - manual cleanup required');
      }
    }
  }
}

export const codePatcher = new CodePatcher();
