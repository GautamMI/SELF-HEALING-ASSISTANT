import { spawn } from 'node:child_process';
import { config } from '../config/env';
import { createLogger } from '../utils/logger';
import type { CommandResult, ValidationReport } from '../types';

const log = createLogger('validator');

const MAX_CAPTURED_OUTPUT = 20_000;

const runCommand = (command: string, args: string[], cwd: string, timeoutMs: number): Promise<CommandResult> =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    const printable = `${command} ${args.join(' ')}`;
    let output = '';
    let timedOut = false;

    const child = spawn(command, args, {
      cwd,
      shell: process.platform === 'win32',
      env: { ...process.env, CI: 'true', FORCE_COLOR: '0' },
    });

    const capture = (chunk: Buffer): void => {
      if (output.length < MAX_CAPTURED_OUTPUT) output += chunk.toString('utf8');
    };

    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        command: printable,
        ok: false,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        output: `${output}\n${error.message}`.trim(),
        timedOut,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        command: printable,
        ok: code === 0 && !timedOut,
        exitCode: code,
        durationMs: Date.now() - startedAt,
        output: output.slice(-MAX_CAPTURED_OUTPUT),
        timedOut,
      });
    });
  });

/**
 * Runs the target application's own quality gates against the patched tree.
 *
 * Policy:
 *  - `typecheck` is BLOCKING. A patch that does not compile is never committed.
 *  - `test` is ADVISORY. The seeded repository ships a deliberately failing
 *    test, so a red suite is expected before that specific defect is healed.
 *    The result is surfaced in the PR body and can downgrade it to a draft.
 */
export class Validator {
  constructor(private readonly targetDir: string = config.paths.targetAppDir) {}

  async validate(): Promise<ValidationReport> {
    const results: CommandResult[] = [];

    if (!config.validation.typecheck && !config.validation.tests) {
      log.warn('validation disabled by configuration');
      return { ok: true, skipped: true, results };
    }

    if (config.validation.typecheck) {
      log.info({ cwd: this.targetDir }, 'running typecheck');
      const typecheck = await runCommand('npm', ['run', '--silent', 'typecheck'], this.targetDir, config.validation.timeoutMs);
      results.push(typecheck);

      if (!typecheck.ok) {
        log.warn({ exitCode: typecheck.exitCode }, 'typecheck failed - patch will be rolled back');
        return { ok: false, skipped: false, results };
      }
    }

    if (config.validation.tests) {
      log.info({ cwd: this.targetDir }, 'running test suite');
      const tests = await runCommand('npm', ['run', '--silent', 'test:ci'], this.targetDir, config.validation.timeoutMs);
      results.push(tests);

      if (!tests.ok) log.warn({ exitCode: tests.exitCode }, 'tests still failing - PR will be marked as draft');
    }

    // Only the blocking gate decides `ok`; test status travels in `results`.
    return { ok: true, skipped: false, results };
  }
}

export const validator = new Validator();
