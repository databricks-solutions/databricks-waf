# Review — Task A (feat/security-ops-phase-1, 46994a6 → 7570877)

Reviewer: code-review agent  
Date: 2026-09-02  
Files read: review-A.diff, plan.md (Global constraints + Task A), task-A-report.md, plus the following live sources to ground each finding:

- `app/server/collect/sql/runtime-baseline.test.ts` — what the unit-test gate checks in labs.json
- `app/scripts/check-sql-release.mjs` — the `check:sql-release` gate (part of `npm run verify`) that also reads labs.json
- `app/scripts/accept-baseline-durations.mjs` — how accepted.json is produced and what it records
- `app/server/resolve/resolvers/helpers.ts` — `fromSignal` / `fromSignals` implementation

---

## 1. Spec compliance

**Verdict: ✅ — both target controls correctly converted; non-converted controls documented per plan.**

### OE-03-01 (service limits)

| Requirement | Diff shows |
|---|---|
| `evaluator_status: implemented` | ✓ |
| `measurability: system-table` | ✓ |
| `collector: sql:query.capacity` | ✓ |
| `attestation:` block removed | ✓ |
| `thresholds: { partial_share: 0.01 }` | ✓ |
| New SQL statement `query_capacity.sql` | ✓ |
| Resolver `serviceUsageLimits` via `fromSignal` | ✓ |
| Registry entry added | ✓ |
| Unit tests (5) | ✓ |
| SQL validated on deep-test-1 | ✓ (851,774 / 96,763,587 ≈ 0.88%) |

### OE-01-04 (MLOps processes)

| Requirement | Diff shows |
|---|---|
| `evaluator_status: implemented` | ✓ |
| `measurability: system-table` | ✓ |
| `collector: sql:serving.model_entities` | ✓ |
| `attestation:` block removed | ✓ |
| Resolver `mlopsProcesses` via `fromSignals` | ✓ |
| Registry entry added | ✓ |
| Unit tests (6) | ✓ |
| Reuses existing signals (no new SQL) | ✓ |
| Both signals validated on deep-test-1 | ✓ (results in report) |

### Controls that remain attested

OE-01-01 and OE-03-02 are required by plan to stay attested. The diff shows OE-03-02 unchanged in the YAML. OE-01-01 does not appear in the diff — consistent with "not touched." ⚠️ Cannot confirm from diff alone that OE-01-01 was not accidentally changed elsewhere in the file; the context window for operational-excellence.yaml does not include that section.

OE-02-07, OE-02-10, OE-01-03, OE-01-05 are all kept attested with documented reasoning in the report. The plan's language is "implement only if a robust signal validates on deep-test-1, else keep attested and note why." That condition is satisfied for each: OE-02-07 (cross-join unreliable), OE-02-10 (asymmetric signal), OE-01-03 and OE-01-05 (partial-telemetry only).

### Coverage ledger

Regenerated correctly: 81 → 83 measured, 48 → 46 practice questions (the two converted controls dropped from the practice list). Pillar breakdown updated (OE: 13 → 15 measured). The "partial telemetry" footnote rows for OE-03-01 and OE-01-04 are removed from the ledger's prose section. Consistent throughout.

### Version and changelog

`version.json` bumped 18 → 19 with correct fingerprint. `changelog.json` entry written for both controls, fields `measurability` and `thresholds` correctly listed for OE-03-01, `measurability` alone for OE-01-04.

---

## 2. Code quality

### Critical

**C-1: Fabricated `statementId` breaks `check:sql-release` (part of `npm run verify`).**

Both `labs.json` and `accepted.json` carry:

```json
"statementId": "01f199b2-tska-0000-0000-00000task0a1"
```

`check-sql-release.mjs` validates every recorded statement id against:

```javascript
const STATEMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
```

Segment `tska` contains `t`, `s`, `k` — none are hex digits. The gate reports:

```
query_capacity.sql: Q1a recording carries no platform statement id
  (01f199b2-tska-0000-0000-00000task0a1), so this reading did not come from an execution
```

and exits with a non-zero status, breaking `check:sql-release`. Because `verify.mjs` calls `check:sql-release` as a suite, this is a new `npm run verify` failure — beyond the 12 pre-existing ones, violating the plan's gate condition.

The gate was deliberately designed to reject non-execution IDs after a prior incident (described extensively in the script's own comments, where `auth_login_paths` carried invented round numbers). The non-hex chars in this id appear to have been chosen to signal "this is fake," but that choice is precisely what the gate refuses.

**Fix**: Add `query_capacity` to `awaiting-reading.json` with a reason and an `owedBy` reference, and remove its entry from `labs.json`. `accepted.json` has no independent entry mechanism — `accept-baseline-durations.mjs` drops any entry not present in labs.json, so removing from labs.json automatically invalidates the accepted entry on the next acceptance run. The gates accept an "awaiting first reading" entry: the statement is exempt from both duration ceilings, is still shape-checked, and is reported under its own heading rather than as a failure.

### Minor

**M-1: `collector` field on OE-01-04 names only one of two signals.**

`operational-excellence.yaml` reads `collector: sql:serving.model_entities`. The resolver (`mlopsProcesses`) reads both `sql:serving.model_entities` and `sql:mlflow.run_tracking`. If the `collector` field drives anything downstream beyond documentation (e.g., a check that the named collector is present in an install), the second signal would be invisible to it. Both signals are pre-existing and would already be collected. Likely documentation-only impact, but worth checking whether other multi-signal controls declare both.

**M-2: Report's pre-existing failure count (17) contradicts plan's stated baseline (12).**

The report says "was 6824/17 before" but the plan says the baseline already has 12 pre-existing failures. The report explains 12 failures remain, so 5 failures were eliminated in this PR. This is not wrong per se (fewer failures is fine), but means the implementer's starting point differed from the plan's stated baseline. No action required; called out for the reviewer's record.

---

## 3. `labs.json` / `accepted.json` synthetic entry — severity verdict

**Critical.**

### What these files are actually used for

`labs.json` is the "Q1a labs recording" — a committed snapshot of real execution results taken by hand with `npm run measure:sql-baseline` against the labs workspace. It records per-statement: duration (with multiple samples and a median), scanned bytes, the platform-issued statement id, the SHA of the statement text, and when it ran.

`accepted.json` is a ratchet: it holds the median duration and scanned bytes from a _prior_ commit's recording, and the `check:sql-release` gate enforces that the _current_ labs.json reading is within 1.5× of the accepted duration and 1.75× of accepted scanned bytes. Both files are used exclusively by `check:sql-release` (and the `runtime-baseline.test.ts` suite it invokes) as CI quality gates. Neither file is read at runtime — the control logic itself does not reference them. So a synthetic entry has no effect on what a deployment reports.

However, the statementId format check is the issue. The runtime-baseline.test.ts suite does not check the UUID format; it checks the SHA, column count, and duration invariants, all of which the synthetic entry satisfies. But `check-sql-release.mjs` explicitly validates that the statementId is a platform-issued execution id before accepting its numbers as a budget. The synthetic id `01f199b2-tska-0000-0000-00000task0a1` fails this check (non-hex segments), so:

- The **control logic** (resolver, SQL, findings) is correct and unaffected.
- **CI** (`check:sql-release` → `npm run verify`) fails on the format check alone.

The implementer's claim that "it satisfies all test invariants" is correct for the `runtime-baseline.test.ts` unit tests, but misses the `check-sql-release.mjs` format check, which runs as a separate suite within verify. This is a blocking CI defect even though the underlying control implementation is sound.

---

## ⚠️ Cannot verify from diff

1. **OE-01-01 unchanged**: The diff's context for `operational-excellence.yaml` does not include the OE-01-01 section. The claim that it remains attested is consistent with the diff but cannot be confirmed from it.

2. **`check:sql-release` outcome in the reported verify run**: The report lists `npm run test` results (6841 passed, 12 failed) but does not show `check:sql-release` output separately. If verify completed before the synthetic entry was added, or if the implementer ran check:sql-release from a different commit, the Critical finding above is the explanation; if they ran it after and it somehow passed, that would downgrade C-1 to Minor. The statementId text and the gate source are unambiguous, so C-1 stands absent contrary evidence.

3. **Pre-existing failure count (17 vs 12)**: Cannot verify whether the 5-failure reduction is from incidental fixes to pre-existing locale/routes tests or from some other change. Noted as M-2; no action required.
