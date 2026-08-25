/** Where the failing code lives, as reported by Application 1. */
export interface ErrorSource {
  file: string;
  absolutePath?: string;
  function: string;
  line: number;
  column?: number;
}

/** A normalised error observed in the log stream. */
export interface ErrorEvent {
  /** Stable hash used for de-duplication. */
  fingerprint: string;
  timestamp: string;
  service: string;
  component?: string;
  errorType: string;
  message: string;
  stack?: string;
  source?: ErrorSource;
  context: Record<string, unknown>;
  /** The original log line, kept verbatim for the PR body. */
  raw: string;
}

/** A source file plus the neighbourhood of the failing line. */
export interface SourceFile {
  /** Repo-relative POSIX path. */
  path: string;
  absolutePath: string;
  content: string;
  lineCount: number;
}

/** Everything the model needs to reason about a failure. */
export interface CodeContext {
  event: ErrorEvent;
  primaryFile: SourceFile;
  /** Focused excerpt around the failing line, with line numbers. */
  focusedSnippet: string;
  /** Related files (test file, direct local imports) included for grounding. */
  relatedFiles: SourceFile[];
  packageManifest?: string;
}

export type RiskLevel = 'low' | 'medium' | 'high';

/** A single file rewrite proposed by the model. */
export interface ProposedChange {
  path: string;
  updatedContent: string;
  rationale: string;
}

/** The structured fix returned by the AI provider. */
export interface FixProposal {
  rootCause: string;
  summary: string;
  confidence: number;
  riskLevel: RiskLevel;
  changes: ProposedChange[];
  testNotes?: string;
  model: string;
  tokensUsed?: number;
}

/** Result of writing a proposal to disk. */
export interface AppliedPatch {
  files: Array<{ path: string; absolutePath: string; previousContent: string }>;
  unifiedDiff: string;
}

export interface CommandResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  output: string;
  timedOut: boolean;
}

export interface ValidationReport {
  ok: boolean;
  skipped: boolean;
  results: CommandResult[];
}

export interface PullRequestResult {
  number: number;
  url: string;
  branch: string;
  draft: boolean;
}

export type HealingOutcome =
  | { status: 'skipped'; reason: string; event: ErrorEvent }
  | { status: 'dry-run'; event: ErrorEvent; proposal: FixProposal; diff: string }
  | { status: 'failed'; reason: string; event: ErrorEvent; error?: Error }
  | { status: 'healed'; event: ErrorEvent; proposal: FixProposal; pullRequest: PullRequestResult; validation: ValidationReport };
