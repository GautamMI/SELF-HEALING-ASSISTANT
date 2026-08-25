import path from 'node:path';
import { config } from '../config/env';

/** Normalises any incoming path to a repo-relative POSIX path. */
export const toRepoRelative = (candidate: string): string => {
  const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(config.paths.repoRoot, candidate);
  return path.relative(config.paths.repoRoot, absolute).split(path.sep).join('/');
};

export const toAbsolute = (candidate: string): string =>
  path.isAbsolute(candidate) ? candidate : path.resolve(config.paths.repoRoot, candidate);

/**
 * Path allow-list. The agent has write access to a git repository, so this is
 * the single most important guardrail in the system: a model must never be
 * able to steer a write outside the directories we explicitly opted in.
 */
export const isPathAllowed = (candidate: string): boolean => {
  const relative = toRepoRelative(candidate);

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  if (relative.split('/').includes('node_modules')) return false;

  return config.guardrails.allowedPathPrefixes.some(
    (prefix) => relative === prefix || relative.startsWith(`${prefix.replace(/\/$/, '')}/`),
  );
};

export const assertPathAllowed = (candidate: string): string => {
  if (!isPathAllowed(candidate)) {
    throw new Error(
      `Refusing to touch "${candidate}": outside ALLOWED_PATH_PREFIXES (${config.guardrails.allowedPathPrefixes.join(', ')})`,
    );
  }
  return toRepoRelative(candidate);
};
