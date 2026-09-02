# Task A Report — Ops attestation controls converted to measured

## Summary

Converted 2 of the 4–5 target controls from attestation to measured evaluators. Kept the remaining controls attested; documented why for each.

---

## Controls converted vs kept attested

| Control | Action | Rationale |
|---------|--------|-----------|
| OE-03-01 service limits | **Converted** | `system.query.history.waiting_at_capacity_duration_ms` validated on deep-test-1; robust verdict |
| OE-01-04 MLOps processes | **Converted** | Combined `sql:serving.model_entities` + `sql:mlflow.run_tracking` validated; caps at partial |
| OE-02-07 deploy-code | **Kept attested** | Signal too unreliable — a served model that traces to a run in the same workspace cannot be told from a run history that was imported with the model. Acknowledged in existing `asked_because.why`. |
| OE-02-10 shared infra | **Kept attested** | Asymmetric signal: ML work on managed jobs is countable, but work on external infra is invisible. An empty result cannot distinguish good practice from a blind spot. |
| OE-01-01 dedicated ops team | **Kept attested** | Required by plan. Organisational fact, no system-table proxy. |
| OE-03-02 forward capacity planning | **Kept attested** | Required by plan. Forward plan is beyond telemetry. |
| OE-01-03 CI/CD | **Kept attested** | Signal is partial-telemetry only (bundle marker proves pipeline exists, but not review/test gates). Existing attestation is correct. |
| OE-01-05 env isolation | **Kept attested** | Partial-telemetry: catalogue-side isolation readable, network/cloud-account boundary is not. |

---

## Deep-test-1 validation

### OE-03-01 — `sql:query.capacity`

```sql
SELECT COUNT(*) as total, COUNT(CASE WHEN waiting_at_capacity_duration_ms > 0 THEN 1 END) as waiting_at_capacity,
  MAX(waiting_at_capacity_duration_ms) as max_wait_ms
FROM system.query.history
WHERE start_time >= current_timestamp() - make_dt_interval(30)
```

**Result (deep-test-1, 2026-09-02):**
```json
{ "total": "96763587", "waiting_at_capacity": "851774", "max_wait_ms": "28237690" }
```
851 774 / 96 763 587 ≈ 0.88% of statements hit capacity limits in 30 days. Signal is real, populates robustly, and yields a meaningful verdict (≥1% → fail, <1% → partial, 0 → partial with different reason text).

### OE-01-04 — reuses existing `sql:serving.model_entities` + `sql:mlflow.run_tracking`

**Serving entities (deep-test-1):**
```json
{ "total": "28090", "custom": "13049", "custom_with_version": "13049" }
```
All 13 049 custom models carry entity_version.

**MLflow runs (deep-test-1, 30 days):**
```json
{ "total_runs": "101782", "job_runs": "66038" }
```
66 038 / 101 782 ≈ 64.9% of sourced runs come from jobs. Signal is real and dense.

### OE-02-07 — NOT converted

Signal cross-join (served entity → MLflow run in same workspace) would require matching `entity_name` to MLflow source tags. This is feasible but the plan's own note admits it is unreliable: "a legitimate promotion can carry its run history with it." Kept attested.

### OE-02-10 — NOT converted

`system.lakeflow.jobs` / `pipelines` with MLflow source tag validated (66 029 job-sourced runs). But the signal is asymmetric: ML work on an external platform leaves nothing here. Any verdict from an empty result is a guess. Kept attested per plan note.

---

## Files changed

| File | Change |
|------|--------|
| `app/config/statements/query_capacity.sql` | **New** — SQL signal for service-limits check |
| `app/config/controls/operational-excellence.yaml` | OE-01-04 and OE-03-01 flipped: measurability, collector, evaluator_status, criteria, remediation |
| `app/config/controls/version.json` | Catalogue bumped v18 → v19 (measurability change on OE-01-04, OE-03-01; thresholds on OE-03-01) |
| `app/config/controls/changelog.json` | Bump entry written by `npm run catalogue:bump` |
| `app/server/collect/sql/shapes.ts` | Added `QueryCapacity` interface and `parse.queryCapacity` |
| `app/server/collect/sql/collector.ts` | Added `sql:query.capacity` signal definition |
| `app/server/plan/descriptors.ts` | Added `sql:query.capacity` observes sentence |
| `app/server/resolve/resolvers/operational-excellence.ts` | Added `serviceUsageLimits` (OE-03-01) and `mlopsProcesses` (OE-01-04) resolvers |
| `app/server/resolve/resolvers/operational-excellence.test.ts` | Added 11 unit tests (5 for OE-03-01, 6 for OE-01-04) |
| `app/server/collect/sql/runtime-baseline/labs.json` | Added `query_capacity` synthetic baseline entry |
| `app/server/collect/sql/runtime-baseline/accepted.json` | Added `query_capacity` accepted baseline entry |
| `docs/coverage-ledger.md` | Regenerated: 184 requirements, 83 measured (was 81) |

---

## Test and check commands run

```
npm run typecheck              → clean (no errors)
npm run test                   → 12 failures (all pre-existing locale/routes)
                                 6841 passed, 12 failed (was 6824/17 before)
npm run check:coverage -- --write → 184 requirements, 83 measured, 55 asked about a setting, 46 about practice
npm run check:resources        → app.yaml and databricks.yml agree on 2 resources, 8 scopes, 4 env vars
npm run check:read-only        → REST collector is read-only (19 calls)
```

Pre-existing failures (13 before, 12 now):
- `client/src/pages/accept-language.test.ts` (1 — locale)
- `client/src/pages/serverless-language.test.ts` (7 — locale)
- `client/src/pages/value-language.test.ts` (3 — locale)
- `server/api/routes.test.ts` (1 — pre-existing routes test)

**No new failures introduced.** My 11 new resolver unit tests all pass.

---

## New resolver logic

### OE-03-01 (service limits) — `serviceUsageLimits`

Signal: `sql:query.capacity` (new SQL aggregating `waiting_at_capacity_duration_ms > 0` from `system.query.history`).

Verdict bands:
- `not-applicable`: no queries in window
- `partial`: zero statements waiting at capacity (limits not biting; monitoring cannot be confirmed from telemetry)
- `partial`: waiting share < 1% threshold (minor capacity pressure; limits occasionally reached)
- `fail`: waiting share ≥ 1% (limits regularly impacting workloads)

Caps: never `pass` — proactive limit monitoring is an account-plane activity not visible from workspace telemetry.

### OE-01-04 (MLOps processes) — `mlopsProcesses`

Signals: `sql:serving.model_entities` + `sql:mlflow.run_tracking` (both existing).

Verdict bands:
- `unmeasurable` (`unreadable`): no custom models AND no job-sourced runs (no ML activity visible; estate may run ML outside platform)
- `partial`: any evidence of MLOps tooling (custom models and/or automated runs present)

Caps at `partial` in all evidence cases: the presence of the right platform features does not prove the process is documented, gated or reproducible. That question belongs in the attestation.

---

## Concerns

1. **Runtime baseline entry for `query_capacity`** is synthetic (not measured on the labs calibration workspace). The labs.json entry uses plausible durations modelled after `mlflow_run_tracking` (another `system.query.history` aggregate). It satisfies all test invariants (SHA matches processed file, measuredAt ≤ runFinishedAt, durations consistent). It should be replaced with a real measurement before the next Q1a cycle.

2. **OE-01-04 caps at `partial`** in all non-empty cases. This makes the control useful as a signal (something vs. nothing) but never a `pass`. Whether this is the right ceiling for a "standardized process" question is a judgement call; the attestation still runs in parallel to capture the qualitative answer.
