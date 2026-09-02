# SDD ledger — plan: /tmp/waf-impl/.sdd/plan.md

Base commit: 46994a6 (main). Branch: feat/security-ops-phase-1.

Baseline: `npm run verify` on base = 12 pre-existing test failures (client language/date: accept-language×1, serverless-language×7, value-language×3; server/api/routes×1). Locale/ICU env-dependent (e.g. renders "25 June 2026", test wants "Jun 25"), unrelated to security/ops resolver/statement/import code. typecheck + committed-bundle + 33/35 checks pass.

Ruling: proceed on this baseline. Gate = no NEW failures beyond the 12 + new unit tests pass + typecheck/check:coverage/check:resources/check:read-only green. Cost if wrong: building on a main whose failing tests are real regressions — low, they are formatting/locale, orthogonal to our files.

Ruling: Task B scope — no planned SCP control has a system-table signal (all 37 blocked-REST). Re-target only the ≤3 with a clean system-table equivalent (SCP-04-22 anchor). Cost if wrong: fewer controls converted than hoped; caught by live validation.

Preflight conflict scan:
- A (ops YAML + ops resolver) vs B (security YAML + security resolver): disjoint files. Shared: server/resolve/index.ts registry + coverage ledger — sequence A→B→C, regen ledger last, each edits its own pillar resolver file.
- C (server/import/signals.ts + store + tests): disjoint from A/B except coverage ledger.
- No task contradicts another or the global constraints. Clean apart from the shared index.ts/ledger noted above.

Execution order: Task A (ops) → Task B (security re-targets) → Task C (bridge revivers) → live-validate on deep-test-1 + deploy/run assessment → final review → PR.

Task A: DONE_WITH_CONCERNS (commit 7570877). 11 new resolver tests pass; typecheck+check:coverage/resources/read-only green; 12 pre-existing failures unchanged. Concern: synthetic query_capacity entry in runtime-baseline/labs.json (modelled on mlflow_run_tracking; SHA valid) — verify in review.

Task A review: Spec OK. CRITICAL C-1: synthetic statementId in labs.json/accepted.json fails check:sql-release (a verify step) — new failure. Minor M-2: report cited 17 baseline vs plan 12 (defer). Ruling: fix loop round 1 — resume implementer to move query_capacity to awaiting-reading.json, drop the synthetic labs/accepted entries, adjust runtime-baseline test, run FULL npm run verify, report exact failing-test list.

Task A: complete (commits 7570877..ebd94f6, C-1 fixed: query_capacity → awaiting-reading.json; full verify 34/35, check:sql-release green, only 12 pre-existing test failures, 0 new). OE-01-01/OE-03-02 untouched.
Ruling: streamline B & C — rely on full `npm run verify` (35 checks incl sql-release/resources/read-only/coverage) + deep-test-1 live validation + ONE final whole-branch review, instead of a per-task reviewer subagent. Why: the app CI gates are objective and strong; context/time constrained; final review still catches cross-task issues. Cost if wrong: a task-local defect slips to the final review instead of being caught per-task (final review + verify still gate it before PR).
