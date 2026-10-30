---
title: Product decisions
description: Settled questions about how the App works, the reason for each, and the code each one governs.
permalink: /decisions/
eyebrow: Collaborate
---

# Product decisions

Each section records one settled question about how the App works: what was decided, why, and which code it governs. Read the matching section before changing that code. A change that settles a new question adds its own section.

## D6: review confirmation accepts due answers

**Status:** decided 2026-10-29 by the product owner

**Decision.** Confirming a pillar accepts every answer that still counts as evidence: a current answer, and an answer that is due for renewal but has not expired. Only an unanswered question or an expired answer has to be dealt with before the pillar can be confirmed.

**Reason.** A due answer has not lapsed. The run scores it and the published report counts it, so refusing it at confirmation would hold a pillar back on evidence the score already rests on. On a 30-day cadence that would block confirmation for the last ten days of every answer. Expiry, the renewal window and the cadence are unchanged, and an expired answer still blocks confirmation.

**Governs:**

- `app/server/review/review.ts`: `pillarEvidenceManifest`, which accepts an answer when `counts()` says it still counts at the moment the pillar is decided.
- `app/server/api/review-routes.ts`: pillar confirmation, which refuses with `pillar-needs-attention` only while an unanswered question or an expired answer remains.
- `app/server/attest/attestation.ts`: `stateOf()` and `counts()`, the one definition of current, due and expired that scoring, confirmation and the published report share.

## A19: dependency advisories are fixed by upgrading Appkit first

**Status:** decided 2026-10-29 by the product owner

**Decision.** When the production dependency audit reports advisories, upgrade `@databricks/appkit` and `@databricks/appkit-ui` to the current release first, and re-run the audit. Add an `overrides` entry in `app/package.json` only for an advisory the upgrade leaves, pinned to the fixed version that the registry serves. Never apply a fix that `npm audit` proposes as a downgrade of Appkit.

**Reason.** Appkit pins many of its transitive dependencies to exact versions, and those pins can lag behind upstream security fixes even in the current release. Upgrading Appkit first still comes before any override: it clears whatever the current release has already moved past, so overrides are needed only for what remains, and every override is one more pin to keep current. Overrides then keep `npm audit` clean for those residual advisories. npm's proposed fixes downgrade Appkit to old releases, which reintroduces the advisories the upgrade removed, so they are rejected. The blocking audit stays meaningful only if it passes because the tree is fixed, not because the advisory was hidden.

**The `@databricks/sdk-*` pins.** `@databricks/sdk-auth`, `@databricks/sdk-core` and `@databricks/sdk-options` are pinned to `0.51.0` in `overrides`, the version Appkit itself declares. `package.json` can't carry comments, so the reason is recorded here. Without the pins, `npm install` and `npm ci` resolve different trees: `npm ci` wants newer nested copies of these packages, and the newer `sdk-auth` brings in `@azure/identity` and the `@azure/msal-node` release that has a high advisory. Pinning them to Appkit's own versions makes both commands resolve the same tree and keeps that chain out. Revisit the three pins, and the other overrides that track Appkit's exact pins, on the next Appkit upgrade, and remove any that the new release no longer needs.

**Governs:**

- `app/package.json`: the `@databricks/appkit` and `@databricks/appkit-ui` versions, and the `overrides` block, where each entry exists for a fixed version Appkit's own pins would otherwise hold back, including the three `@databricks/sdk-*` pins above.
- `app/osv-scanner.toml`: lists only findings with no published fix, each with a reason, a reachability argument and an expiry.
- `.github/workflows/security.yml` and `.github/workflows/dependency-advisories.yml`: the blocking `npm audit --omit=dev --audit-level=high` step.

## A6: probe failures carry a machine-readable refusal

**Status:** decided 2026-10-29 by the product owner

**Decision.** A probe that no app can make is not attempted. The REST collector answers it as unmeasurable and attaches a structured refusal to the signal: `{ kind: 'ungrantable-scope', scope }` for an endpoint that needs a scope Databricks Apps does not offer, and `{ kind: 'account-plane' }` for an endpoint that needs an account administrator. The reader-facing reason still names the scope in the platform's `required scopes: <scope>` form. A remedy reads the refusal before it looks at any text, and a refusal always means `attest`. Text matching stays as the fallback for stored signals that predate the field.

**Reason.** The reason is prose for a person, and its wording changes. Deciding what a reader can do by matching that prose let a platform limit read as a defect in this app: sixteen controls that only an administrator can answer reported "could not be read" with the advice to report a bug, where the controls behind the live refused probes correctly asked for an answer. A fact the collector knew before any call should reach the remedy as a fact. The field is optional inside the stored signal, so earlier scans keep the classification they were recorded with and no schema changes.

**Governs:**

- `app/server/collect/signal.ts`: `Refusal` and the optional `SignalResult.refusal`.
- `app/server/collect/rest/probes.ts`: `AdminOnlyProbe`, a probe with no `run()`.
- `app/server/collect/rest/collector.ts`: `refusedWithoutCalling`, which answers an admin-only probe without a control-plane call.
- `app/server/resolve/remedy.ts`: `one()` reads the refusal first, then falls back to `demandedScope` and the family table.

## A1: identity comes from the verified token, never from a forwarded header

**Status:** decided 2026-10-29 by the product owner

**Decision.** A change is attributed to the identity the workspace returns for the caller's token: the `userName` from the SCIM current-user answer. A forwarded identity header is never the name a change is recorded under. When the header is present and names someone other than that `userName`, compared without regard to case, the change is refused with `403 identity-mismatch` and the refusal is recorded in the audit trail under the verified name. A request with no header is attributed to the verified `userName`. A service principal is recorded under its application id, which is its `userName`, with its display name kept beside it as `actorName`. Read-only routes keep the header shortcut, because they attribute nothing.

**Reason.** Permission to change an assessment is decided on the groups SCIM lists for the token. If the name written beside the act came from somewhere else, a change could be authorised for one person and recorded against another, and the audit trail would stop describing who was permitted. Using the one name that the groups belong to keeps authorisation and attribution on the same principal. A mismatch is refused rather than resolved in favour of either name, because nothing in the request says which one is right. The app does not control the proxy in front of it, so it does not rely on the proxy to have replaced the header.

**Governs:**

- `app/server/api/routes.ts`: `permitted()`, which calls `verifiedIdentityFrom` and `requireVerifiedIdentity` before the membership check, and records a refusal through `options.audit?.refused`. `identityFrom` and `identify` keep the header for reads.
- `app/server/authorize/group.ts`: `requireVerifiedIdentity`, and `identity-mismatch` among the kinds of `NotPermittedError`.

## D1: stored results are shared in full, and the detail behind them only with assessors

**Status:** decided 2026-10-29 by the product owner

**Decision.** Published results, scores, findings outcomes and summaries are readable by every person who can open the App. Three kinds of field are shown only to direct members of `WAF_ASSESSOR_GROUP`: the text of a statement in an advisory, the principal identifiers in a finding's evidence (the holders of tokens, and the accounts that jobs run as), and the raw readings an administrator imported, together with the name of whoever collected them. Every other reader gets a typed placeholder in the same place. It says that the field is withheld and names the group whose direct members can see it. The check is the one that gates a change: the forwarded token, the groups the workspace lists for it, and agreement between the forwarded identity and the verified one. A request with no token, an identity lookup that fails and a lookup that lists no groups all count as not being an assessor, so detail is withheld while the summaries are still served. The answer is worked out once per request and kept for nothing longer. The same projection applies to the CSV and JSON exports, so a download cannot carry what the screen does not show.

**Reason.** A run reads the estate as the person or service principal who started it, so what it stores reflects that identity's grants and not the grants of whoever opens the record later. Saying that anyone who can open the App can read a stored result because they could run the scan again themselves is not true of the detail: a reader may not hold the grants the run held. Scores, outcomes and summaries do not name a principal or quote a statement, so sharing them with everyone is what lets a stakeholder read an assessment without being an assessor. Restricting the detail to the group that already holds the authority to change an assessment adds no new role, and a placeholder tells everyone else why a field is missing and who to ask. There is no per-row access control and no separate reader-detail group, and what is collected and stored is unchanged: the record is stored whole and the projection runs when it is read. Because it runs on read, it covers records written before this decision and leaves the bytes and digests of published results untouched.

**An export differs by reader.** A file built for a reader outside the group carries placeholders where an assessor's carries detail, so its digest differs too. The digest listed beside a file is the digest of the file that reader downloads.

**Governs:**

- `app/server/share/reader.ts`: `assessorCheck`, the per-request test of direct membership that fails closed.
- `app/server/share/projection.ts`: the projection of evidence, findings, scans, results, advisories and imports, including which evidence names a principal (`carriesPrincipals`).
- `app/shared/api/contract.ts`: `WithheldPayload`, the placeholder, and the fields that carry it.
- `app/server/api/routes.ts`, `app/server/api/review-routes.ts`, `app/server/api/advisory-routes.ts` and `app/server/api/import-routes.ts`: every read and export route that can carry one of these fields.
- `app/client/src/components/WithheldNote.tsx`: where the client prints the placeholder.
- `app/server/scan/postgres-store.ts` and `app/config/statements/workload_query_shapes.sql`: the comments that state this policy as the reason stored detail is not open to every reader.

## D7: no transactional strict audit mode; a lost audit event is recorded durably

**Status:** decided 2026-10-29 by the product owner

**Decision.** The App does not write an action and its audit event in one transaction. `WAF_AUDIT_STRICT=1` checks that the audit trail answers before an action and refuses the action when it does not. `WAF_AUDIT_STRICT=0` performs the action and records the loss. An append that fails after the trail answered cannot be prevented at either value, so it is recorded: the App writes a marker to an append-only `audit_gaps` table in the same database, through the pool rather than on the connection the failed append used. A marker holds the time, the action, the actor, the target and the class of the failure, and no payload and no driver message. Every instance reads the same table, so Diagnostics lists the unacknowledged markers whichever instance lost the event or serves the request, and a restart does not clear them. The in-memory count stays and is labelled as the current instance's. Acknowledging a marker is an act of its own, gated like any other change to direct members of `WAF_ASSESSOR_GROUP` and recorded in the trail. It adds a row beside the marker and does not alter it. If the marker cannot be written either, the count and the App log are what remain.

**Reason.** A transactional mode would make the audit table a single point of failure for every change in the App: a database blip would stop somebody answering a requirement, and it would bind every store to one connection when the stores take the pool a statement at a time. The default posture refuses that trade, and the strict posture's check before the action already refuses the case it can see. What was missing was that the one piece of evidence of the case it cannot see, a count in memory, disappeared on the next deploy. A durable marker makes the loss evident after a restart and from every instance without changing what an action costs, and it leaves the hash-chain format and the default posture alone. Acknowledgement says that a person has looked and does not recover the event, so it changes what Diagnostics reports and nothing the trail's verification reads.

**Governs:**

- `docs/configuration.md`: the `WAF_AUDIT_STRICT` row and the section that describes both values and what they cannot promise.
- `app/server/audit/record.ts`: `AuditRecorder.record` and `mark`, which write the marker when an append fails, and the `gaps` option and getter.
- `app/server/store/audit-gaps.ts`: the marker store, its in-memory twin, and the acknowledgement row.
- `app/server/store/postgres.ts`: the `audit_gaps` table and its unique index, which refuses a second acknowledgement of one marker.
- `app/server/health/health.ts` and `app/server/api/health-routes.ts`: the marker list on `/api/diagnostics`, and the gated `POST /api/diagnostics/audit-gaps/:id/acknowledge`.
- `app/client/src/pages/DiagnosticsPage.tsx` and `app/client/src/components/AuditGapList.tsx`: the list and the acknowledge button.
- `app/server/admin/reset.ts` and `app/server/admin/retention.ts`: a reset empties the markers with the trail they describe, and a retention period never removes one.

## A16: an install may run on several instances; the database admits one live run per kind

**Status:** decided 2026-10-29 by the product owner

**Decision.** The App supports two or more instances behind one URL, and three things that used to be held in one process's memory are now decided where the instances meet.

1. **Admission.** At most one assessment run and one advisory run are live at a time across all instances. `PostgresRunStore.open` takes `pg_advisory_xact_lock(hashtext('waf.run-admission.' || kind))` in the transaction that opens a run, reads the unfinished runs, and inserts only if none of that kind is live. A run is live while its lease has not lapsed, or for one lease window after it was asked for if nothing has claimed it yet. A run whose holder stopped renewing is not live, so a dead instance does not block the install, and it is still taken back up by its own idempotency key. A trigger with the same key as the live run is not refused at this step; it reaches the existing duplicate-key path and is told why it cannot join. Any other trigger, with another key or none, is refused. The two kinds do not wait for each other. The lock is released by the commit or rollback, and a handle that cannot open a transaction refuses to admit anything.
2. **Refusal.** A refused trigger writes no run, answers `409` with the same in-progress error as before (`scan-in-progress`, and `advisory-in-progress` for an advisory run), and names the live run. A trigger that this instance can already see will be refused is turned away before anything is written. A refused attempt does not change the pointer to the run this instance is collecting, and does not leave a failed run behind.
3. **Status.** `/api/scan/status` reads the live assessment run from the run record, so every instance reports the same scan, with the starter, scope and trigger. The progress count (`callsMade`) is shown only by the instance doing the work, because nothing durable holds it. Where nothing durable is bound, or the record cannot be read, the instance's own runner answers.

Durable audit gaps, the other state that was per instance, are decided in D7.

**Reason.** Databricks Apps run one to five instances behind one URL, and a rolling deploy serves two versions at once. The in-process lock stops two scans in one instance and can't see another, so two people could start two scans and double the load on the warehouse for the same answer. The database is the one thing every instance shares, and an advisory lock taken in the admitting transaction is what makes "read what is live, then insert" safe against another instance doing the same. It adds no table or column, so two versions can run against one database during a deploy. Reading status from the run record means a page served by a different instance from the one that started the scan is still told it is running.

**Not decided here.** Scans do not run in parallel, and cancelling is still the cancel flag in the run record, which the instance holding the run reads between collection units.

**Governs:**

- `app/server/run/run-store.ts`: `PostgresRunStore.open`, the advisory lock, the read of unfinished runs and the refusal.
- `app/server/run/run.ts`: `live`, which says when a run counts against admission, and `RunAdmissionRefused`, which carries the run that was lost to.
- `app/server/run/runs.ts`: the early refusal, the translation of an admission refusal into `ScanInProgressError` and `AdvisoryInProgressError`, the per-kind pointer to the run this instance is collecting, and `live()`, which the status route reads.
- `app/server/api/routes.ts`: `/api/scan/status` and the `scan-in-progress` response, which names the run.
- `app/server/api/advisory-routes.ts`: the `advisory-in-progress` response.
- `app/server/store/postgres-fake.ts`: sessions that wait for one another, and the advisory transaction lock, which the fake accepts only inside a session.
- `docs/install.md` and `docs/user-guide.md`: the statement that more than one instance is supported.

## A9: scheduled service-principal runs are the system of record for trends and monthly publications

**Status:** decided 2026-10-29 by the product owner

**Decision.** The scheduled service principal's runs are the record the App's trends and monthly publications are built from, and its grants are managed as code.

1. **Closing reading.** A month closes on its latest scheduled run. A month with no scheduled run closes on its latest scan of any kind, and the document says so. A scan that did not record how it was started is not counted as scheduled.
2. **Opening reading.** The reading a month opened at is the newest earlier scan that `comparable()` admits against the closing reading. A newer earlier scan that is not comparable is passed over, not measured against.
3. **No comparable opening.** The movement and finding-change sections are empty. The document carries `comparable()`'s reason, or says that no scan finished before the month, in the same way the trend section carries the reason for a point it cannot place. A scan with no recorded measurement basis cannot be shown to be comparable and does not qualify.
4. **Trend.** Each earlier month in a month's trend closes on the same rule, so consecutive points come from one identity. The History page lists the scheduled runs by default, with the runs started by hand one filter away and every run under All.
5. **Grants as code.** The principal's access is declared and reviewed, not granted by hand: `npm run schedule:principal`, or the customer's own bundle or Terraform.
6. **Document version.** The monthly document version is 2. A month published under version 1 may carry a movement between two readings that were not comparable, and it stays a valid record of its own version; published months are not edited.

**Reason.** A published month is immutable, so what it says about movement has to be true of the estate. A scan run by an assessor sees what that assessor sees, a different lookback or methodology asks a different question, and a movement across any of those measures the observer. The scheduled principal is the one identity, lookback and schedule an install keeps constant, which makes its runs the series a trend and a monthly record can rest on. Interactive runs remain recorded and listed. They just do not close a month or open a movement.

**Governs:**

- `app/server/monthly/content.ts`: `closingScan`, which prefers the scheduled run; `openingReading`, which chooses the comparable opening; and `monthContent`, which empties the movement sections and carries the reason.
- `app/server/monthly/document.ts`: `MONTH_DOCUMENT_VERSION`, and the `closing` and `movementNote` fields of the document and its CSV.
- `app/server/api/publication-routes.ts`: the assembly of a month's opening and closing readings, shared by preview, publish and correction, and the closing scan each earlier month's trend point is read from.
- `app/client/src/pages/HistoryPage.tsx` and `app/client/src/pages/schedule-language.ts`: the scan filter and its scheduled default.
- `docs/scheduled-scans.md`: the scheduled principal and its grants.
