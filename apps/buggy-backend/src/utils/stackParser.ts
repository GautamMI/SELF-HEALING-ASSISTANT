import path from 'node:path';
import { REPO_ROOT } from '../config/env';
import type { ErrorSource } from '../types';

/** One parsed frame of a V8 stack trace. */
export interface StackFrame {
  functionName: string;
  absolutePath: string;
  line: number;
  column: number;
  isProjectFile: boolean;
}

/**
 * Matches both stack frame shapes V8 produces:
 *   at CartService.applyCoupon (/repo/apps/x/src/a.ts:12:9)
 *   at /repo/apps/x/src/a.ts:12:9
 */
const FRAME_PATTERN = /^\s*at\s+(?:(?<fn>.+?)\s+\()?(?<location>.+?):(?<line>\d+):(?<column>\d+)\)?\s*$/;

const stripFileUrl = (location: string): string =>
  location.startsWith('file://') ? decodeURIComponent(location.replace(/^file:\/\//, '')) : location;

const isProjectFile = (absolutePath: string): boolean => {
  const relative = path.relative(REPO_ROOT, absolutePath);
  return (
    Boolean(relative) &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative) &&
    !relative.split(path.sep).includes('node_modules')
  );
};

/** Parses a raw stack string into structured frames (best effort, never throws). */
export const parseStack = (stack?: string): StackFrame[] => {
  if (!stack) return [];

  return stack
    .split('\n')
    .slice(1) // first line is "ErrorType: message"
    .map((rawLine) => {
      const match = FRAME_PATTERN.exec(rawLine);
      if (!match?.groups) return null;

      const absolutePath = path.resolve(stripFileUrl(match.groups.location as string));
      const line = Number.parseInt(match.groups.line as string, 10);
      const column = Number.parseInt(match.groups.column as string, 10);
      if (!Number.isFinite(line) || !Number.isFinite(column)) return null;

      return {
        functionName: (match.groups.fn ?? '<anonymous>').replace(/^(async|new)\s+/, ''),
        absolutePath,
        line,
        column,
        isProjectFile: isProjectFile(absolutePath),
      } satisfies StackFrame;
    })
    .filter((frame): frame is StackFrame => frame !== null);
};

/**
 * Resolves the *first* frame that belongs to our own source tree. That frame is
 * what the self-healing agent will open, so we deliberately skip node_modules
 * and Node internals rather than reporting the top-of-stack frame blindly.
 */
export const resolveErrorSource = (error: unknown): ErrorSource | undefined => {
  const stack = error instanceof Error ? error.stack : undefined;
  const frame = parseStack(stack).find((candidate) => candidate.isProjectFile);
  if (!frame) return undefined;

  // Compiled output (dist/*.js) is mapped back to TypeScript by
  // `source-map-support`, so the path we emit here is already the .ts file.
  return {
    file: path.relative(REPO_ROOT, frame.absolutePath).split(path.sep).join('/'),
    absolutePath: frame.absolutePath,
    function: frame.functionName,
    line: frame.line,
    column: frame.column,
  };
};
