import type { CodeContext } from '../types';

/**
 * The system prompt is deliberately strict about three things:
 *  - output shape (strict JSON, whole-file rewrites),
 *  - scope (minimal change, no refactors, no new dependencies),
 *  - honesty (low confidence must be reported, not hidden).
 */
export const SYSTEM_PROMPT = `You are a senior Node.js/TypeScript engineer operating an automated repair pipeline.
You receive a production error together with the source file that produced it, and you return a minimal, correct fix.

Hard rules:
1. Respond with a SINGLE JSON object and nothing else. No markdown, no code fences, no commentary.
2. Fix the root cause of the reported error. Do not refactor unrelated code, rename symbols, reformat the file, or reorder imports.
3. Preserve the existing coding style, comment style, public API and exported names exactly.
4. Never introduce a new npm dependency. Use only what already exists in the provided package manifest and the Node standard library.
5. Return the COMPLETE final content of every file you change. Never truncate, never use placeholders such as "..." or "// unchanged".
6. Keep TypeScript strict-mode clean: no 'any' escapes, no non-null assertions added to silence the compiler.
7. Preserve or add structured logging where an error is now handled instead of thrown.
8. If the correct fix requires information you do not have, still return your best minimal change and set confidence below 0.5.
9. Only modify files that were provided to you. Never invent file paths.

JSON schema of your reply:
{
  "rootCause": "one or two sentences explaining WHY the error happened",
  "summary": "imperative one-line description of the change, e.g. 'Guard against unknown coupon codes'",
  "confidence": 0.0-1.0,
  "riskLevel": "low" | "medium" | "high",
  "changes": [
    { "path": "<exact repo-relative path as provided>", "updatedContent": "<complete file content>", "rationale": "why this edit fixes it" }
  ],
  "testNotes": "how a reviewer should verify the fix"
}`;

const renderRelatedFiles = (context: CodeContext): string => {
  if (context.relatedFiles.length === 0) return '(none)';

  return context.relatedFiles
    .map((file) => `--- FILE: ${file.path} ---\n${file.content}`)
    .join('\n\n');
};

export const buildUserPrompt = (context: CodeContext): string => {
  const { event, primaryFile } = context;

  return `## Error event

- service: ${event.service}
- type: ${event.errorType}
- message: ${event.message}
- occurred at: ${event.timestamp}
- reported source: ${event.source?.file ?? 'unknown'} :: ${event.source?.function ?? 'unknown'} (line ${event.source?.line ?? '?'})
- context: ${JSON.stringify(event.context)}

## Stack trace

\`\`\`
${(event.stack ?? '(no stack trace captured)').slice(0, 4000)}
\`\`\`

## Failing region of ${primaryFile.path} (line-numbered, >> marks the reported line)

\`\`\`
${context.focusedSnippet}
\`\`\`

## Full current content of ${primaryFile.path}

\`\`\`typescript
${primaryFile.content}
\`\`\`

## Related files (read-only context unless the fix genuinely requires changing them)

${renderRelatedFiles(context)}

## package.json of the target application

\`\`\`json
${context.packageManifest ?? '{}'}
\`\`\`

## Your task

Produce the minimal correct fix for this specific error, following every rule in your instructions.
Editable paths are limited to: ${[primaryFile.path, ...context.relatedFiles.map((file) => file.path)].join(', ')}.
Reply with the JSON object only.`;
};

/** Extra turn appended when the first attempt fails validation. */
export const buildRetryPrompt = (failureOutput: string): string =>
  `Your previous fix was applied but validation failed. Correct it and reply with the same JSON schema.

Validation output (truncated):
\`\`\`
${failureOutput.slice(0, 3000)}
\`\`\``;
