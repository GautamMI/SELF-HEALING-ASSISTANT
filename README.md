# AI-Powered Self-Healing Developer Assistant

Two Node.js + TypeScript applications that together demonstrate a complete, production-shaped
self-healing loop:

```
Application 1 throws  →  structured error log  →  Application 2 detects it
        →  locates the source file  →  OpenAI proposes a fix  →  patch applied
        →  typecheck + tests  →  git branch + commit + push  →  GitHub Pull Request
```

* **Application 1 — `apps/buggy-backend`** — a small Express API that ships six intentional defects
  and writes machine-readable error logs (pino → `logs/error.log`), including the **exact source file,
  function and line** that failed.
* **Application 2 — `apps/self-healing-agent`** — tails that log, rebuilds the code context, asks
  OpenAI for a minimal fix, applies it behind an allow-list, validates it, commits it on a fresh
  branch and opens a pull request for human review.

---

## Table of contents

1. [Project structure](#project-structure)
2. [How it works](#how-it-works)
3. [The six intentional bugs](#the-six-intentional-bugs)
4. [The log contract](#the-log-contract)
5. [Setup](#setup)
6. [Running the demo](#running-the-demo)
7. [Configuration reference](#configuration-reference)
8. [Safety rails](#safety-rails)
9. [Testing](#testing)
10. [Docker](#docker)
11. [Design decisions](#design-decisions)
12. [Assumptions](#assumptions)
13. [Troubleshooting](#troubleshooting)

---

## Project structure

```
self-healing-assistant/
├── apps/
│   ├── buggy-backend/                    # Application 1
│   │   ├── src/
│   │   │   ├── index.ts                  # express bootstrap + process-level safety nets
│   │   │   ├── config/env.ts             # zod-validated .env loader (fails fast)
│   │   │   ├── middleware/
│   │   │   │   ├── errorHandler.ts       # single terminal error path
│   │   │   │   └── requestContext.ts     # request id + access logging
│   │   │   ├── routes/
│   │   │   │   ├── cart.routes.ts        # one endpoint per intentional bug
│   │   │   │   └── internal.routes.ts    # stub "pricing service" with a drifted contract
│   │   │   ├── services/
│   │   │   │   ├── cart.service.ts       # ⚠️ contains the intentional bugs
│   │   │   │   ├── cart.repository.ts    # in-memory carts
│   │   │   │   └── pricing.client.ts     # axios client (mocked in tests)
│   │   │   ├── utils/
│   │   │   │   ├── logger.ts             # pino, dual sink (error.log + stdout)
│   │   │   │   ├── stackParser.ts        # V8 stack → file/function/line
│   │   │   │   ├── errorReporter.ts      # the one place errors get logged
│   │   │   │   └── asyncHandler.ts
│   │   │   └── types/
│   │   ├── tests/
│   │   │   ├── cart.service.test.ts      # includes the intentionally failing test
│   │   │   ├── cart.routes.test.ts       # supertest, axios mocked
│   │   │   └── reporters/failureLogReporter.js   # mirrors Jest failures into error.log
│   │   ├── scripts/trigger-bugs.ts       # demo driver
│   │   ├── logs/error.log                # ← the contract between the two apps
│   │   ├── .env / .env.example
│   │   ├── jest.config.js
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── self-healing-agent/               # Application 2
│       ├── src/
│       │   ├── index.ts                  # entry point: watcher → serial queue → pipeline
│       │   ├── config/env.ts             # zod-validated configuration
│       │   ├── watcher/logWatcher.ts     # chokidar + byte-offset tailing
│       │   ├── parser/errorParser.ts     # JSON log line → ErrorEvent + fingerprint
│       │   ├── dedup/errorCache.ts       # in-memory TTL cache
│       │   ├── context/contextBuilder.ts # locate + read source, snippet, related files
│       │   ├── ai/
│       │   │   ├── prompts.ts            # system + user prompts
│       │   │   └── fixGenerator.ts       # OpenAI call, retries, schema + guardrails
│       │   ├── patcher/codePatcher.ts    # apply, diff, rollback
│       │   ├── validation/validator.ts   # npm run typecheck / test:ci
│       │   ├── git/
│       │   │   ├── gitOps.ts             # simple-git: branch, commit, push
│       │   │   └── githubPr.ts           # Octokit: create/reuse PR
│       │   ├── pipeline/healingPipeline.ts   # orchestration + rollback
│       │   ├── utils/                    # logger, paths allow-list, queue, rate limiter
│       │   └── types/index.ts
│       ├── tests/                        # unit tests for parser, cache, queue, limiter
│       ├── .env.example
│       ├── package.json
│       └── tsconfig.json
│
├── docker/                               # Dockerfiles for both apps
├── docs/
│   ├── sample-pull-request.md            # example of a generated PR
│   └── demo-script.md                    # 5–10 minute recording script
├── docker-compose.yml
├── package.json                          # npm workspaces root
├── .env.example
└── README.md
```

---

## How it works

| # | Stage | Module | Notes |
|---|-------|--------|-------|
| 1 | **Detect** | `watcher/logWatcher.ts` | Chokidar watches `error.log`. Only the byte delta since the last read is loaded, so memory is flat regardless of file size. Truncation and rotation rewind the offset. |
| 2 | **Parse** | `parser/errorParser.ts` | Each line is JSON-parsed and validated with zod. Non-error levels and malformed lines are skipped silently. Produces an `ErrorEvent` with a stable **fingerprint**. |
| 3 | **De-duplicate** | `dedup/errorCache.ts` | Fingerprint = errorType + normalised message + file:function. A crash-looping endpoint produces **one** PR, not hundreds. TTL default 15 min. |
| 4 | **Build context** | `context/contextBuilder.ts` | Resolves the file from `errorSource.file` → `absolutePath` → stack frames, in that order. Reads the full file, builds a line-numbered ±30-line window around the failure, and attaches the spec file, local imports and `package.json`. |
| 5 | **Generate fix** | `ai/fixGenerator.ts` | OpenAI Chat Completions in JSON mode. Response is schema-checked with zod, then run through guardrails (allow-listed paths, only files we supplied, truncation detection, max files per fix). Retries with exponential backoff on 429/5xx/timeouts. |
| 6 | **Apply** | `patcher/codePatcher.ts` | Captures the previous content of every file, writes the new content, produces a unified diff, and rolls back automatically if any step fails. |
| 7 | **Validate** | `validation/validator.ts` | Runs the target app's own `npm run typecheck` (**blocking**) and `npm run test:ci` (**advisory**). A patch that does not compile is rolled back and the model gets one retry with the compiler output. |
| 8 | **Commit** | `git/gitOps.ts` | Branches from the base branch, stages **only** the patched files, writes a conventional-commit message with a traceability trailer, pushes with a token injected for that single invocation. |
| 9 | **Pull request** | `git/githubPr.ts` | Octokit creates (or reuses) the PR with root cause, diff, validation table and the original log line. Marked **draft** when tests are still red or confidence is low. |

Every failure path rolls the working tree back and returns you to the branch you started on.

---

## The six intentional bugs

All of them live in `apps/buggy-backend/src/services/cart.service.ts`, each marked with a `BUG #n`
comment. Every one still **compiles cleanly** under `strict` mode — they are runtime and logic
defects, which is what makes them realistic.

| # | Defect | Trigger | Symptom |
|---|--------|---------|---------|
| 1 | Null / undefined property access | `POST /api/cart/checkout` with `cart-1001` (coupon `FESTIVE50` is not in the catalogue) | `TypeError: Cannot read properties of undefined (reading 'discount')` |
| 2 | Divide by zero | `GET /api/cart/cart-empty/split` | `RangeError: Division by zero` (BigInt minor-unit maths on an empty cart) |
| 3 | Invalid API response handling | `GET /api/cart/cart-1001/pricing` | Upstream returns `{ status, data }`, code reads `response.prices` → `TypeError: Cannot read properties of undefined (reading 'map')` |
| 4 | Unhandled runtime error | `GET /api/cart/cart-badmeta/metadata` | `SyntaxError` from `JSON.parse` on a malformed third-party payload |
| 5 | Unhandled runtime error | `POST /api/cart/cart-1001/reserve` with `{"region":"EU"}` | `TypeError: provider.reserve is not a function` |
| 6 | Failing unit test | `npm run test:backend` | Tax is rounded with `Math.round` instead of to 2 decimals; `cart.service.test.ts › rounds tax to two decimal places` fails |

Bug #6 is deliberately routed through the same pipe as the runtime errors: a custom Jest reporter
(`tests/reporters/failureLogReporter.js`) writes failures into `error.log` using the identical
envelope, and maps the spec file back to the implementation under test. The agent needs **zero**
special-casing for "test failure" versus "runtime exception".

---

## The log contract

`apps/buggy-backend/logs/error.log` is newline-delimited JSON. One line, one error:

```json
{
  "level": "error",
  "time": "2026-08-25T17:24:11.482Z",
  "service": "buggy-backend",
  "component": "error-handler",
  "errorType": "TypeError",
  "err": {
    "type": "TypeError",
    "message": "Cannot read properties of undefined (reading 'discount')",
    "stack": "TypeError: Cannot read properties of undefined…"
  },
  "errorSource": {
    "file": "apps/buggy-backend/src/services/cart.service.ts",
    "absolutePath": "/…/apps/buggy-backend/src/services/cart.service.ts",
    "function": "CartService.applyCoupon",
    "line": 79,
    "column": 41
  },
  "sourceFile": "apps/buggy-backend/src/services/cart.service.ts",
  "sourceFunction": "CartService.applyCoupon",
  "sourceLine": 79,
  "context": { "route": "POST /api/cart/checkout", "requestId": "…", "input": { … } },
  "msg": "Cannot read properties of undefined (reading 'discount')"
}
```

`errorSource` is produced by `utils/stackParser.ts`, which walks the V8 stack and picks the **first
frame inside our own source tree** — never `node_modules`, never a Node internal. Paths are
repo-relative so the agent can resolve them from a different working directory (or a different
container). In compiled mode, `source-map-support` maps `dist/*.js` frames back to `.ts`.

---

## Setup

### Prerequisites

* Node.js **≥ 18.18** (Node 20 LTS recommended) and npm 9+
* Git, and a GitHub repository you can push to
* An OpenAI API key

### Install

```bash
git clone <your-fork-url> self-healing-assistant
cd self-healing-assistant
npm install                 # npm workspaces installs both apps
```

### Configure

```bash
cp .env.example .env
cp .env.example apps/self-healing-agent/.env   # optional: the agent reads either file
```

Fill in at minimum:

```dotenv
OPENAI_API_KEY=sk-…
GITHUB_TOKEN=github_pat_…      # Contents: read/write, Pull requests: read/write
GITHUB_OWNER=your-username
GITHUB_REPO=self-healing-assistant
GIT_BASE_BRANCH=main
```

> **Try it without credentials first:** set `DRY_RUN=true`. The agent will detect, analyse, patch and
> validate locally, print the diff, and stop before touching git or GitHub.

Push this repository to GitHub before running for real — the agent needs an `origin` remote and a
base branch that exists.

---

## Running the demo

Three terminals.

**Terminal 1 — Application 1**

```bash
npm run dev:backend
# → buggy-backend listening on :4000
```

**Terminal 2 — Application 2**

```bash
npm run dev:agent
# → watching error log … agent ready - waiting for errors
```

**Terminal 3 — cause some damage**

```bash
npm run trigger:bugs          # fires all five runtime bugs, 1.5s apart
npm run trigger:bugs -- 1 3   # or just a subset
npm run test:backend          # produces the failing-unit-test event
```

Watch Terminal 2:

```
🚨 error detected            errorType=TypeError  source=apps/buggy-backend/src/services/cart.service.ts
starting healing run
resolved failing source file file=…/cart.service.ts line=79
requesting fix from OpenAI   model=gpt-4o-mini
fix proposal received        confidence=0.92 riskLevel=low
patched file                 file=apps/buggy-backend/src/services/cart.service.ts
running typecheck            → pass
running test suite
created fix branch           branch=autofix/typeerror-cannot-read-properties-a1b2c3d4
committed fix
pushed fix branch
✅ healing run complete      pr=42 url=https://github.com/you/repo/pull/42
```

Useful extras:

```bash
npm run logs:clear                                   # truncate error.log between takes
npm run heal:once --workspace @self-healing/agent    # single-shot mode, exits after one heal
tail -f apps/buggy-backend/logs/error.log | jq .     # watch the raw contract
```

---

## Configuration reference

### Application 1 — `apps/buggy-backend/.env`

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | HTTP port |
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `SERVICE_NAME` | `buggy-backend` | Stamped on every log line |
| `LOG_LEVEL` | `debug` | Console verbosity (`error.log` is always error+) |
| `LOG_DIR` / `LOG_FILE` | `logs` / `error.log` | Where the contract file lives |
| `LOG_PRETTY` | `true` | Pretty console output; the file stays raw JSON either way |
| `PRICING_API_URL` | self-hosted stub | Downstream dependency used by BUG #3 |
| `PRICING_API_TIMEOUT_MS` | `4000` | Axios timeout |

### Application 2 — `.env` / `apps/self-healing-agent/.env`

| Variable | Default | Description |
|---|---|---|
| `WATCH_LOG_FILE` | `apps/buggy-backend/logs/error.log` | File to tail |
| `PROCESS_EXISTING_ON_START` | `false` | Replay pre-existing lines (handy for demos) |
| `WATCH_USE_POLLING` | `false` | Enable on Docker bind mounts / network shares |
| `REPO_ROOT` | repo root | Git repository the agent operates on |
| `TARGET_APP_DIR` | `apps/buggy-backend` | Where validation commands run |
| `ALLOWED_PATH_PREFIXES` | `apps/buggy-backend/src` | **Hard write allow-list** |
| `MAX_FILES_PER_FIX` | `3` | Rejects sprawling rewrites |
| `OPENAI_MODEL` | `gpt-4o-mini` | Any Chat Completions model with JSON mode (`gpt-4o`, `gpt-4.1`, …) |
| `OPENAI_TEMPERATURE` | `0.1` | Low by design — this is repair, not brainstorming |
| `OPENAI_MAX_RETRIES` | `3` | Backoff on 429/5xx/timeout |
| `MIN_CONFIDENCE` | `0.55` | Below this the PR opens as a draft |
| `DRY_RUN` | `false` | Analyse + patch locally, never commit or push |
| `DEDUP_TTL_MS` | `900000` | Fingerprint suppression window |
| `MAX_HEALS_PER_HOUR` | `5` | Sliding-window budget |
| `VALIDATE_TYPECHECK` | `true` | **Blocking** gate |
| `VALIDATE_TESTS` | `true` | Advisory gate; failure ⇒ draft PR |
| `GIT_BRANCH_PREFIX` | `autofix` | Branch namespace |
| `GIT_PUSH_ENABLED` | `true` | Set `false` to commit locally only |
| `PR_LABELS` | `self-healing,automated-fix` | Applied best-effort |

---

## Safety rails

An agent with write access to a repository and an LLM in the loop needs to be boring and predictable:

1. **Path allow-list** (`utils/paths.ts`) — every write is re-validated against
   `ALLOWED_PATH_PREFIXES` after the model responds. Traversal, absolute paths and `node_modules`
   are rejected. The model cannot steer a write outside the opted-in directories.
2. **Only files we supplied** — the model may not invent paths; it can edit only what was in its
   context.
3. **Truncation detection** — a rewrite shorter than 40% of the original, or containing an
   `// ... unchanged` placeholder, is rejected outright.
4. **Blocking typecheck** — code that does not compile is never committed. The model gets one retry
   with the compiler output attached.
5. **Rollback everywhere** — patch failure, validation failure, git failure and PR failure all
   restore the previous file contents and the original branch.
6. **Fingerprint de-duplication** — one PR per distinct defect per TTL window.
7. **Rate limiting** — `MAX_HEALS_PER_HOUR` caps blast radius and API spend.
8. **Serial execution** — a single async queue guarantees exactly one healing run mutates the
   working tree at a time.
9. **Never auto-merge** — the loop ends at "PR opened". Draft when confidence is low or tests are
   still red. A human always approves.
10. **Secret hygiene** — tokens are redacted in logs and injected into the push URL for one
    invocation only; they are never written to `.git/config`.

---

## Testing

```bash
npm test              # both workspaces
npm run test:agent    # parser, dedup cache, queue, rate limiter — all green
npm run test:backend  # 8 pass, 1 intentional failure (BUG #6)
npm run typecheck     # both workspaces, strict mode, clean
```

`test:backend` is **expected to report one failure** — that is the seeded defect. Once the agent
heals it, the suite goes green. The agent's own suite must always be green.

External calls are mocked: the pricing client is injected and stubbed with `jest.mock`/`jest.spyOn`,
and no test performs network I/O.

---

## Docker

```bash
cp .env.example .env      # OPENAI_API_KEY / GITHUB_* are read by the agent container
docker compose up --build
```

* Both containers share `error.log` through the `error-logs` volume.
* The repository (including `.git`) is bind-mounted into the agent at `/workspace` so it can patch,
  commit and push.
* `WATCH_USE_POLLING=true` is set for the agent because bind mounts do not emit reliable inotify
  events on every host.

Trigger bugs against the containerised API with
`curl -X POST -H 'content-type: application/json' -d '{"cartId":"cart-1001"}' http://localhost:4000/api/cart/checkout`.

---

## Design decisions

**Why a log file instead of an in-process hook?** The two applications must stay genuinely decoupled —
that is the point of the exercise, and it mirrors production, where the healer reads from a log
pipeline rather than living inside the failing service. Newline-delimited JSON is the lowest-common
denominator that every language and log shipper already speaks; swapping the watcher for a
CloudWatch/Loki/Datadog consumer means replacing one module.

**Why does Application 1 log the source location itself?** Scraping stack traces on the consumer side
is brittle. The producer already has the `Error` object and knows its own layout, so it resolves
file/function/line once, at the point of failure, and publishes it as part of the contract. The agent
then does a lookup, not an investigation.

**Why whole-file rewrites rather than diffs or line edits?** Models are far more reliable at emitting
a complete file than a context-accurate unified diff, and a whole file is trivially verifiable
(compile it). Truncation — the real risk — is caught explicitly by the length and placeholder checks.
For files above a few hundred lines an anchored search/replace strategy would be the next step.

**Why is typecheck blocking but tests advisory?** A non-compiling patch is unambiguously wrong. A red
test suite is not: this repository intentionally ships one failing test, and in the real world a
suite can be red for reasons unrelated to the defect being repaired. So the compiler gates the
commit, and test results travel into the PR body and downgrade it to draft.

**Why fingerprints rather than raw messages?** `Cart 1001 is invalid` and `Cart 2044 is invalid` are
one bug. Numbers, UUIDs and quoted values are normalised before hashing, and the file/function is
folded in, so the same defect from a different call site is still distinguishable.

**Why a serial queue?** Healing mutates the git index. Two concurrent runs would interleave branches
and staged files. A dependency-free `AsyncQueue` makes the invariant explicit and testable.

---

## Assumptions

* The agent runs on the same machine (or with the same repository mounted) as the code it repairs —
  it edits a real working tree, not a remote checkout.
* The repository has an `origin` remote and the base branch (`main` by default) exists.
* A human reviews and merges every pull request. Nothing is auto-merged, ever.
* Node ≥ 18.18 is available in both the agent's and the target app's environment (the validator
  shells out to `npm`).
* Log lines are newline-delimited JSON at error level or above; anything else is ignored.
* The target application exposes `npm run typecheck` and `npm run test:ci`. Point
  `TARGET_APP_DIR` elsewhere and those two scripts are the only contract required.
* OpenAI is reachable and the configured model supports JSON response format.
* The `errorSource` block is produced by Application 1; if it is absent the agent falls back to
  scraping stack frames, and gives up cleanly if nothing resolvable is found.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `OPENAI_API_KEY is empty` warning | Add the key to `.env` (repo root or `apps/self-healing-agent/.env`). |
| Agent starts but never reacts | Check `WATCH_LOG_FILE` resolves to the file the backend is writing (the backend logs the absolute path at boot). On Docker/WSL/network shares set `WATCH_USE_POLLING=true`. |
| `Could not resolve an editable source file` | The failure came from `node_modules` or outside `ALLOWED_PATH_PREFIXES`. Widen the allow-list only if you mean to. |
| `Refusing to touch …` | Working as intended — the model proposed a path outside the allow-list. |
| `No "origin" remote configured` | Push the repo to GitHub and add the remote, or set `DRY_RUN=true`. |
| PR creation fails with 403 | The token needs **Contents: read/write** and **Pull requests: read/write** on that repository. |
| PR opened as a draft | Tests are still failing or confidence < `MIN_CONFIDENCE`. Set `PR_DRAFT_ON_VALIDATION_FAILURE=false` to change that. |
| `duplicate error suppressed` | Same fingerprint inside `DEDUP_TTL_MS`. Restart the agent or lower the TTL while demoing. |
| `hourly healing budget exhausted` | Raise `MAX_HEALS_PER_HOUR`. |
| Working tree left dirty after a crash | `git checkout -- apps/buggy-backend/src` — the patcher keeps originals in memory, so a hard kill mid-write is the only way to reach this state. |
