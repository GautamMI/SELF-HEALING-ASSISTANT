# Demo video script (5–10 minutes)

## 0:00 — Setup (45s)
- Show the repo tree: two apps, `apps/buggy-backend` and `apps/self-healing-agent`.
- Open `.env` and point out `OPENAI_API_KEY`, `GITHUB_TOKEN`, `ALLOWED_PATH_PREFIXES`.
- `npm run typecheck` → both workspaces clean.

## 0:45 — Application 1 (1m30s)
- `npm run dev:backend`.
- Open `src/services/cart.service.ts`, scroll the six `BUG #n` markers.
- `curl -X POST -d '{"cartId":"cart-1001"}' -H 'content-type: application/json' localhost:4000/api/cart/checkout`
  → 500 with a stable error envelope including the resolved source location.
- `tail -1 apps/buggy-backend/logs/error.log | jq .` → show `errorSource.file/function/line`.
  **This is the contract between the two apps.**

## 2:15 — Application 2 starts (45s)
- `npm run dev:agent` in a second terminal.
- Point out the boot line: watch file, repo root, model, allow-list, heal budget.

## 3:00 — The full loop (3m)
- Third terminal: `npm run trigger:bugs`.
- Narrate the agent log as it goes:
  `🚨 error detected` → `resolved failing source file` → `requesting fix from OpenAI`
  → `fix proposal received (confidence, risk)` → `patched file` → `running typecheck`
  → `running test suite` → `created fix branch` → `committed fix` → `pushed` → `✅ pr=NN`.
- Show `git log -1` and `git diff main...autofix/...`.
- Open the pull request on GitHub: root cause, diff, validation table, original log line.

## 6:00 — The failing unit test path (1m)
- `npm run test:backend` → one intentional failure.
- Show that the Jest reporter wrote the same envelope into `error.log`, mapped back to
  `cart.service.ts`, and the agent healed it with no special-casing.

## 7:00 — Safety rails (1m30s)
- De-duplication: re-run the same bug → `duplicate error suppressed`.
- Path allow-list in `utils/paths.ts`.
- Blocking typecheck + automatic rollback; draft PRs on low confidence.
- `DRY_RUN=true` mode.
- Rate limiting and the serial queue.

## 8:30 — Wrap (30s)
- Recap the pipeline diagram from the README.
- Emphasise: the loop ends at "PR opened" — a human always reviews.
