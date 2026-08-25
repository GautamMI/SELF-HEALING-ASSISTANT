import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/env';
import { createLogger } from '../utils/logger';
import { isPathAllowed, toAbsolute, toRepoRelative } from '../utils/paths';
import type { CodeContext, ErrorEvent, SourceFile } from '../types';

const log = createLogger('context-builder');

const SNIPPET_RADIUS = 30;
const MAX_FILE_BYTES = 200 * 1024;
const RELATIVE_IMPORT_PATTERN = /(?:from\s+|require\()\s*['"](\.[^'"]+)['"]/g;
const STACK_FRAME_PATTERN = /at\s+(?:.+?\s+\()?([^\s()]+\.[tj]sx?):(\d+):(\d+)\)?/g;

export class ContextBuilderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextBuilderError';
  }
}

const readSourceFile = async (repoRelativePath: string): Promise<SourceFile> => {
  const absolutePath = toAbsolute(repoRelativePath);
  const stats = await fs.stat(absolutePath);

  if (!stats.isFile()) throw new ContextBuilderError(`${repoRelativePath} is not a file`);
  if (stats.size > MAX_FILE_BYTES) {
    throw new ContextBuilderError(`${repoRelativePath} is ${stats.size} bytes, above the ${MAX_FILE_BYTES} byte limit`);
  }

  const content = await fs.readFile(absolutePath, 'utf8');

  return {
    path: toRepoRelative(absolutePath),
    absolutePath,
    content,
    lineCount: content.split('\n').length,
  };
};

const exists = async (absolutePath: string): Promise<boolean> => {
  try {
    await fs.access(absolutePath);
    return true;
  } catch {
    return false;
  }
};

/**
 * Resolution order for "which file broke?":
 *  1. `errorSource.file` emitted by the application (authoritative).
 *  2. `errorSource.absolutePath`, remapped onto this machine's repo root.
 *  3. The first project-owned frame scraped from the raw stack trace.
 */
const locateSourceFile = async (event: ErrorEvent): Promise<{ file: string; line: number }> => {
  const candidates: Array<{ file: string; line: number }> = [];

  if (event.source?.file) candidates.push({ file: event.source.file, line: event.source.line ?? 0 });
  if (event.source?.absolutePath) candidates.push({ file: event.source.absolutePath, line: event.source.line ?? 0 });

  for (const match of (event.stack ?? '').matchAll(STACK_FRAME_PATTERN)) {
    candidates.push({ file: match[1] as string, line: Number(match[2]) });
  }

  for (const candidate of candidates) {
    const relative = toRepoRelative(candidate.file);

    if (!isPathAllowed(relative)) {
      log.debug({ candidate: relative }, 'candidate rejected by path allow-list');
      continue;
    }

    if (await exists(toAbsolute(relative))) return { file: relative, line: candidate.line };
  }

  throw new ContextBuilderError(
    `Could not resolve an editable source file for "${event.errorType}: ${event.message}". ` +
      `Checked ${candidates.length} candidate path(s).`,
  );
};

/** Renders a line-numbered window around the failing line. */
const buildFocusedSnippet = (file: SourceFile, line: number): string => {
  const lines = file.content.split('\n');
  const target = Math.min(Math.max(line, 1), lines.length);
  const start = Math.max(0, target - SNIPPET_RADIUS);
  const end = Math.min(lines.length, target + SNIPPET_RADIUS);
  const width = String(end).length;

  return lines
    .slice(start, end)
    .map((text, index) => {
      const lineNumber = start + index + 1;
      const marker = lineNumber === target ? '>>' : '  ';
      return `${marker} ${String(lineNumber).padStart(width, ' ')} | ${text}`;
    })
    .join('\n');
};

/** Sibling files worth showing the model: the spec file and local imports. */
const collectRelatedFiles = async (primary: SourceFile): Promise<SourceFile[]> => {
  const related = new Map<string, SourceFile>();
  const primaryDir = path.dirname(primary.absolutePath);
  const baseName = path.basename(primary.path).replace(/\.ts$/, '');

  const testCandidates = [
    path.join(config.paths.targetAppDir, 'tests', `${baseName}.test.ts`),
    path.join(primaryDir, `${baseName}.test.ts`),
    path.join(primaryDir, '__tests__', `${baseName}.test.ts`),
  ];

  for (const candidate of testCandidates) {
    if (await exists(candidate)) {
      const file = await readSourceFile(toRepoRelative(candidate));
      related.set(file.path, file);
      break;
    }
  }

  for (const match of primary.content.matchAll(RELATIVE_IMPORT_PATTERN)) {
    const specifier = match[1] as string;
    const resolved = ['.ts', '/index.ts', '.js'].map((suffix) => path.resolve(primaryDir, `${specifier}${suffix}`));

    for (const candidate of resolved) {
      if (related.size >= 3) break;
      if (!isPathAllowed(candidate)) continue;
      if (!(await exists(candidate))) continue;

      const file = await readSourceFile(toRepoRelative(candidate));
      if (file.path !== primary.path) related.set(file.path, file);
      break;
    }
  }

  return [...related.values()];
};

/**
 * Assembles everything the model needs: the failing file, a focused excerpt,
 * closely related files and the target app's manifest (so proposed fixes stay
 * within dependencies that actually exist).
 */
export const buildCodeContext = async (event: ErrorEvent): Promise<CodeContext> => {
  const located = await locateSourceFile(event);
  const primaryFile = await readSourceFile(located.file);

  log.info({ file: primaryFile.path, line: located.line, fingerprint: event.fingerprint }, 'resolved failing source file');

  let packageManifest: string | undefined;
  const manifestPath = path.join(config.paths.targetAppDir, 'package.json');
  if (await exists(manifestPath)) packageManifest = await fs.readFile(manifestPath, 'utf8');

  return {
    event,
    primaryFile,
    focusedSnippet: buildFocusedSnippet(primaryFile, located.line),
    relatedFiles: await collectRelatedFiles(primaryFile),
    packageManifest,
  };
};
