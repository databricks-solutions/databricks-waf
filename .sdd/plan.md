# Plan — Security & Ops pillar Phase-1 improvements
Branch: feat/security-ops-phase-1. Spec = the three issue drafts (admin-evidence bridge / in-app planned evaluators / ops attestation conversions).
Implementer reference (READ FIRST): /tmp/waf-impl/.sdd/PATTERNS.md

## Global constraints
- Match the existing resolver / statement / control-YAML / test patterns exactly (see PATTERNS.md).
- Do NOT add new app scopes (app.yaml / databricks.yml user_api_scopes stay as-is). `npm run check:read-only` and `check:resources` must pass.
- Every new SQL signal MUST be validated against deep-test-1 live system tables (CLI profile `deep-test-1`) before its control is claimed measured. Use `databricks experimental aitools tools query "<sql>" --profile deep-test-1` (substitute a real workspace id for params).
- Regenerate the coverage ledger once with `npm run check:coverage -- --write`.
- Baseline `npm run verify` already has 12 pre-existing failures in client language/date tests (accept-language, serverless-language, value-language) + 1 routes test — locale/ICU env issues, NOT ours. Do not touch those. Gate = no NEW failures beyond those 12, new unit tests pass, typecheck + check:coverage + check:resources + check:read-only green.
- Work read-only against the platform; controls only READ system tables / granted APIs.

## Task A — Ops: convert attestation controls to measured (Issue 3)
Validate each signal on deep-test-1; implement those that yield a robust verdict, keep the rest attested and report which.
- OE-03-01 service limits ← system.query.history (share of queries with waiting_at_capacity_duration_ms > 0 in window)
- OE-02-07 deploy-code ← system.mlflow.runs_latest + system.serving.served_entities (served custom-model versions tracing to a tracked run)
- OE-01-04 MLOps ← system.mlflow + system.serving.served_entities (served models with a registered version + tracked run)
- OE-02-10 shared infra ← system.lakeflow.jobs / pipelines (share of ML work run as managed jobs/pipelines)
Keep OE-01-01 (dedicated ops team) and OE-03-02 (forward capacity planning) attested. OE-01-05 env-isolation and OE-01-03 CI/CD: implement only if a robust signal validates on deep-test-1, else keep attested and note why.
Per control: new config/statements/<name>.sql, flip the control in config/controls/operational-excellence.yaml (evaluator_status→implemented, measurability system-table, collector id, thresholds/partial bands), add resolver + registry entry in server/resolve/resolvers/operational-excellence.ts, add a resolver unit test. Then `npm run check:coverage -- --write`.
Acceptance: converted controls report measured verdicts; each SQL validated on deep-test-1 (paste the row counts/sample in the report); unit tests pass; typecheck/check:resources/check:read-only green; no new verify failures.

## Task B — Security: re-target planned controls to system-table signals (Issue 2)
FACT: no planned SCP control has a system-table signal today — all 37 planned use blocked-REST collectors (secrets/clusters/settings/account-plane, ADR 0016). Re-target the ones with a clean system-table equivalent (validate on deep-test-1):
- SCP-04-22 jobs run as service principal ← system.lakeflow.jobs (run_as identity)  [ANCHOR — highest confidence]
- SCP-04-05 managed tables in DBFS root ← system.information_schema.tables (managed table storage under dbfs root)  [if it validates]
- SCP-04-03 long-running clusters ← system.compute.clusters (+ node_timeline if uptime is needed)  [if it validates]
Implement those that validate on deep-test-1; leave the rest `planned` (they need the admin bridge, Task C). Same file pattern as Task A, in the security YAML + security resolver file/registry. Confirm each re-targeted control's collector id + evaluator_status flip is consistent with check:resources.
Acceptance: re-targeted controls flip planned→implemented and report measured verdicts validated on deep-test-1; unit tests pass; checks green. Report which were implemented vs left planned and why.

## Task C — Admin-evidence bridge: revive held signals (Issue 1)
Per coverage-ledger: 34 signals are "collected, held" (config/evidence/collect-evidence.py collects them but there's no REVIVER), 3 "not collected". Extend the REVIVERS map in server/import/signals.ts so held admin signals revive into the live shape their resolver consumes (imported NEVER overrides a live observation; a refusal revives as unmeasurable, not as an observation of absence — match the existing reviver invariants). Prefer the highest-value held signals (log delivery, account IP access lists, disable-legacy-features, SP secret staleness, secrets scope inventory, cluster disk encryption) — implement as many held signals as cleanly map; report the list.
Add unit tests: feed a sample admin envelope for each new reviver → assert the revived shape + that the resolver emits a finding tagged imported/admin-collected. Then `npm run check:coverage -- --write` (held → imported should move).
Acceptance: new revivers unit-tested (sample envelope → finding, provenance imported); coverage ledger reflects held→imported; typecheck/checks green. NOTE: a full collect-evidence.py run under account-admin creds is out of environment scope — the reviver path is unit-tested with sample envelopes.
