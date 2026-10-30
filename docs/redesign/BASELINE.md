# Redesign Regression Baseline

Established 2026-09-22 on `feat/ui-ux-redesign` (identical to `main`), before any redesign change.

## Result
- **All 34 non-test checks pass** (`typecheck`, `lint`, `check:design-system`, `check:a11y`, `check:viewport`, and the rest of `check:*`).
- **Full test suite: 403 test files, 6978 tests.**
  - Under this machine's default locale (en-AU): **11 tests fail**, all currency/date formatting only, in `client/src/pages/{accept-language,serverless-language,value-language}.test.ts` (e.g. expects `$1,000`/`Jul 1, 2026`, gets `USD 1,000`/`1 July 2026`).
  - Under **`LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8`**: **0 failures — fully green** (matches real CI, which runs en-US).

## Gate for the redesign
Run all test/verify commands with the en-US locale prefix:

```bash
cd app
LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 npm run verify
LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 npm run check:design-system
LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 npm run check:a11y
LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 npm run check:viewport
```

Expected after every task/batch: **fully green (0 test failures) + all `check:*` green.** Any failure is a redesign regression to fix before commit. Never weaken a contract/behavior/permission test to make it pass.
