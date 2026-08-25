import OpenAI from 'openai';
import { z } from 'zod';
import { config } from '../config/env';
import { createLogger } from '../utils/logger';
import { isPathAllowed, toRepoRelative } from '../utils/paths';
import { SYSTEM_PROMPT, buildRetryPrompt, buildUserPrompt } from './prompts';
import type { CodeContext, FixProposal } from '../types';

const log = createLogger('fix-generator');

const FixProposalSchema = z.object({
  rootCause: z.string().min(1),
  summary: z.string().min(1),
  confidence: z.coerce.number().min(0).max(1),
  riskLevel: z.enum(['low', 'medium', 'high']).default('medium'),
  changes: z
    .array(
      z.object({
        path: z.string().min(1),
        updatedContent: z.string().min(1),
        rationale: z.string().default('n/a'),
      }),
    )
    .min(1),
  testNotes: z.string().optional(),
});

export class FixGenerationError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'FixGenerationError';
  }
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const isRetryable = (error: unknown): boolean => {
  if (error instanceof OpenAI.APIError) return RETRYABLE_STATUS.has(error.status ?? 0);
  if (error instanceof FixGenerationError) return true; // malformed JSON: worth one more roll
  return error instanceof Error && /ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(error.message);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Strips accidental ```json fences before parsing. */
const extractJson = (raw: string): unknown => {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');

  if (start === -1 || end === -1 || end <= start) {
    throw new FixGenerationError('Model reply did not contain a JSON object');
  }

  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (error) {
    throw new FixGenerationError('Model reply was not valid JSON', error);
  }
};

/**
 * Post-model guardrails. The model is untrusted input: every path is re-checked
 * against the allow-list, restricted to files we actually handed it, and each
 * rewrite is sanity-checked for truncation.
 */
const enforceGuardrails = (proposal: FixProposal, context: CodeContext): FixProposal => {
  const editable = new Map<string, number>([
    [context.primaryFile.path, context.primaryFile.content.length],
    ...context.relatedFiles.map((file) => [file.path, file.content.length] as [string, number]),
  ]);

  const changes = proposal.changes.map((change) => {
    const normalisedPath = toRepoRelative(change.path);

    if (!isPathAllowed(normalisedPath)) {
      throw new FixGenerationError(`Model tried to modify a disallowed path: ${change.path}`);
    }

    const originalLength = editable.get(normalisedPath);
    if (originalLength === undefined) {
      throw new FixGenerationError(`Model tried to modify a file it was not given: ${change.path}`);
    }

    if (change.updatedContent.length < originalLength * 0.4) {
      throw new FixGenerationError(
        `Rewrite of ${normalisedPath} looks truncated (${change.updatedContent.length} vs ${originalLength} chars)`,
      );
    }

    if (/\/\/\s*\.\.\.\s*(unchanged|rest of)/i.test(change.updatedContent)) {
      throw new FixGenerationError(`Rewrite of ${normalisedPath} contains an elision placeholder`);
    }

    return { ...change, path: normalisedPath, updatedContent: change.updatedContent.replace(/\r\n/g, '\n') };
  });

  const unchanged = changes.filter((change) => {
    const source =
      change.path === context.primaryFile.path
        ? context.primaryFile.content
        : context.relatedFiles.find((file) => file.path === change.path)?.content;
    return source !== undefined && source.replace(/\r\n/g, '\n') === change.updatedContent;
  });

  if (unchanged.length === changes.length) {
    throw new FixGenerationError('Model returned the files unchanged - no fix to apply');
  }

  if (changes.length > config.guardrails.maxFilesPerFix) {
    throw new FixGenerationError(
      `Model wanted to change ${changes.length} files, limit is ${config.guardrails.maxFilesPerFix}`,
    );
  }

  return { ...proposal, changes: changes.filter((change) => !unchanged.includes(change)) };
};

export class FixGenerator {
  private readonly client: OpenAI;

  constructor(client?: OpenAI) {
    this.client =
      client ??
      new OpenAI({
        apiKey: config.openai.apiKey,
        timeout: config.openai.timeoutMs,
        maxRetries: 0, // retries are handled here so we can log every attempt
      });
  }

  /**
   * Asks the model for a fix. `previousFailure` turns the call into a repair
   * round-trip: the model sees why its last attempt failed validation.
   */
  async generate(context: CodeContext, previousFailure?: string): Promise<FixProposal> {
    if (!config.openai.apiKey) {
      throw new FixGenerationError('OPENAI_API_KEY is not configured');
    }

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(context) },
    ];

    if (previousFailure) messages.push({ role: 'user', content: buildRetryPrompt(previousFailure) });

    let lastError: unknown;

    for (let attempt = 1; attempt <= config.openai.maxRetries + 1; attempt += 1) {
      const startedAt = Date.now();

      try {
        log.info({ attempt, model: config.openai.model, file: context.primaryFile.path }, 'requesting fix from OpenAI');

        const completion = await this.client.chat.completions.create({
          model: config.openai.model,
          temperature: config.openai.temperature,
          max_tokens: config.openai.maxOutputTokens,
          response_format: { type: 'json_object' },
          messages,
        });

        const raw = completion.choices[0]?.message?.content;
        if (!raw) throw new FixGenerationError('OpenAI returned an empty completion');

        const parsed = FixProposalSchema.safeParse(extractJson(raw));
        if (!parsed.success) {
          throw new FixGenerationError(
            `Model reply failed schema validation: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
          );
        }

        const proposal = enforceGuardrails(
          { ...parsed.data, model: config.openai.model, tokensUsed: completion.usage?.total_tokens },
          context,
        );

        log.info(
          {
            attempt,
            durationMs: Date.now() - startedAt,
            confidence: proposal.confidence,
            riskLevel: proposal.riskLevel,
            files: proposal.changes.map((change) => change.path),
            tokensUsed: proposal.tokensUsed,
          },
          'fix proposal received',
        );

        return proposal;
      } catch (error) {
        lastError = error;
        const retryable = isRetryable(error) && attempt <= config.openai.maxRetries;

        log.warn(
          { attempt, retryable, error: (error as Error).message, durationMs: Date.now() - startedAt },
          'fix generation attempt failed',
        );

        if (!retryable) break;
        await sleep(Math.min(2 ** attempt * 500, 8000));
      }
    }

    throw lastError instanceof FixGenerationError
      ? lastError
      : new FixGenerationError(`Fix generation failed: ${(lastError as Error)?.message ?? 'unknown error'}`, lastError);
  }
}

export const fixGenerator = new FixGenerator();
