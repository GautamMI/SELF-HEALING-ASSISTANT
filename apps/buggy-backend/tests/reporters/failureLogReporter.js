'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..');
const LOG_PATH = path.join(APP_ROOT, process.env.LOG_DIR || 'logs', process.env.LOG_FILE || 'error.log');

const FRAME_PATTERN = /at\s+(?:(.+?)\s+\()?(\/[^\s)]+?):(\d+):(\d+)\)?/g;
const SRC_DIR = path.join(APP_ROOT, 'src');

/** Recursively looks for `<name>.ts` under src/ - used to map a spec file back
 *  to the implementation it exercises (cart.service.test.ts -> cart.service.ts). */
function findImplementationFile(baseName) {
  const stack = [SRC_DIR];

  while (stack.length > 0) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name === `${baseName}.ts`) return full;
    }
  }

  return null;
}

/**
 * Picks the first stack frame that lives inside our own `src` tree so the
 * healing agent patches the implementation, not the spec file.
 */
function resolveSourceFromFailure(failureMessage, testFilePath) {
  const candidates = [];
  let match;
  while ((match = FRAME_PATTERN.exec(failureMessage || '')) !== null) {
    candidates.push({ fn: match[1] || '<anonymous>', file: match[2], line: Number(match[3]), column: Number(match[4]) });
  }

  const implementation = candidates.find(
    (frame) => frame.file.startsWith(path.join(APP_ROOT, 'src')) && !frame.file.includes('node_modules'),
  );
  const fallback = candidates.find((frame) => !frame.file.includes('node_modules'));
  const chosen = implementation || null;

  if (!chosen) {
    // The assertion failed inside the spec file, so the stack never enters
    // src/. Map the spec back to the implementation under test instead - that
    // is the file the healing agent actually needs to edit.
    const baseName = path.basename(testFilePath).replace(/\.test\.tsx?$/, '');
    const implementationPath = findImplementationFile(baseName);
    const target = implementationPath || (fallback && fallback.file) || testFilePath;

    return {
      file: path.relative(REPO_ROOT, target).split(path.sep).join('/'),
      absolutePath: target,
      function: implementationPath ? '<unit-under-test>' : '<test>',
      line: 1,
      column: 1,
    };
  }

  return {
    file: path.relative(REPO_ROOT, chosen.file).split(path.sep).join('/'),
    absolutePath: chosen.file,
    function: chosen.fn,
    line: chosen.line,
    column: chosen.column,
  };
}

/**
 * Jest reporter that appends failing tests to logs/error.log using the same
 * pino envelope the HTTP layer emits. That keeps Application 2 free of any
 * special-case "is this a test failure?" branching.
 */
class FailureLogReporter {
  onTestResult(_test, testResult) {
    const failures = testResult.testResults.filter((result) => result.status === 'failed');
    if (failures.length === 0) return;

    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });

    const lines = failures.map((failure) => {
      const rawMessage = (failure.failureMessages || []).join('\n');
      const errorSource = resolveSourceFromFailure(rawMessage, testResult.testFilePath);
      const title = failure.fullName || failure.title;

      return JSON.stringify({
        level: 'error',
        time: new Date().toISOString(),
        service: process.env.SERVICE_NAME || 'buggy-backend',
        env: 'test',
        hostname: os.hostname(),
        pid: process.pid,
        component: 'jest',
        errorType: 'FailedUnitTest',
        err: {
          type: 'FailedUnitTest',
          message: `Failing test: ${title}`,
          stack: rawMessage.slice(0, 8000),
        },
        errorSource,
        sourceFile: errorSource.file,
        sourceFunction: errorSource.function,
        sourceLine: errorSource.line,
        context: {
          operation: 'jest.testFailure',
          testFile: path.relative(REPO_ROOT, testResult.testFilePath).split(path.sep).join('/'),
          testName: title,
        },
        msg: `Failing test: ${title}`,
      });
    });

    fs.appendFileSync(LOG_PATH, `${lines.join('\n')}\n`, 'utf8');
  }
}

module.exports = FailureLogReporter;
