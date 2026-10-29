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

**Decision.** A change is attributed to the identity the workspace returns for the caller's token: the `userName` from the SCIM current-user answer. A forwarded identity header is never the name a change is recorded under. When the header is present and names someone other than that `userName`, compared without regard to case, the change is refused with `403 identity-mismatch` and the refusal is recorded in the audit trail under the verified name. A request with no header is attributed to the verified `userName`. If the workspace returns no `userName` for a token (for example a minimal stub or a custom principal record), there is nothing to compare, and `verifiedIdentityFrom` falls back to the forwarded header actor. A service principal is recorded under its application id, which is its `userName`, with its display name kept beside it as `actorName`. Read-only routes keep the header shortcut, because they attribute nothing.

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

## A7: a job's run-as identity is classified on its name, with no directory lookup

**Status:** decided 2026-10-29 by the product owner

**Decision.** The job inventory reads `run_as_user_name` beside `run_as`, and the run-as control (`SCP-04-22`) classifies on the name:

1. **An email address is a user.** A value with text on both sides of a single `@` counts as a user account.
2. **A UUID is a service principal.** The platform writes a service principal's application ID there.
3. **Anything else is unknown.** A group name, or any other value that is neither of the above, is reported and left out of the share's denominator. A name that was never recorded is unknown too.
4. **No directory lookup.** A name is never resolved through SCIM or any other identity API.

The verdict bands are unchanged. The share that decides the outcome is service principals over users and service principals, and the evidence says how many jobs could not be classified. When no job can be classified, the control is not applicable.

**Reason.** In `system.lakeflow.jobs`, `run_as` holds the ID of the user or service principal, so it carries an ID for both kinds and cannot tell them apart. `run_as_user_name` holds the email of the user, the application ID of the service principal, or a group name, which can. The control therefore reads `run_as_user_name`. A service principal whose name is not a UUID is treated as unknown, because its shape cannot be told from a group name. The name column is not populated for rows written before early December 2025, so an unrecorded name is unknown rather than a pass or a fail. A directory lookup would add calls and depend on APIs that not every reader of the estate can use, to resolve a shape the name already carries for users and service principals. The schema is documented at <https://docs.databricks.com/aws/en/admin/system-tables/jobs>.

**Governs:**

- `app/config/statements/jobs_inventory.sql`: projects `run_as_user_name` as `run_as_name` beside `run_as`.
- `app/server/collect/sql/shapes.ts`: `JobRow.runAsName` and the job row parser.
- `app/server/resolve/resolvers/security-jobs.ts`: `runAsKind`, which classifies the name, and the `SCP-04-22` resolver, which lists user-run jobs by name.
- `app/server/share/projection.ts`: unchanged. The name is a principal identifier, and it is withheld from readers outside the assessor group in the same evidence as before.

## D2: an answer lifts a capped partial and never lowers a measurement

**Status:** decided 2026-10-29 by the product owner

**Decision.** Five measured units stop at `partial` because the platform shows that a practice has an artefact and cannot show that the artefact is the whole practice. A current "met" answer, or one that is due for renewal but has not expired (`counts()`), lifts that `partial` to `pass`. The resolver marks the `partial` as a cap, and only a marked `partial` is lifted.

| Unit | The `partial` that a "met" lifts | What no answer changes |
| --- | --- | --- |
| `OE-01-02`, `OE-02-01`, `IU-01-05` (one alias group) | any job deployed by an asset bundle | |
| `OE-01-04` | MLOps tooling in use | |
| `OE-01-06` | more than one catalog | one catalog (`fail`) |
| `IU-04-01`, `IU-04-02` | tables carry tags | no tags with 80% or more of tables described (`partial`), and no tags below that (`fail`) |
| `OE-03-01` | no statement waited at a capacity limit | some waiting, up to 1% (`partial`), and more than 1% (`fail`) |

Three rules hold for every unit:

1. **Nothing lifts a `fail` or a shortfall the app measured.** An answer decides an outcome the app could not read, and it lifts a cap the resolver marked. It does not overturn a measurement.
2. **No answer lowers a measurement.** "Partially-met", "not-met" and "not-applicable" leave the measured outcome as it is. They are recorded beside it and not counted.
3. **More measured adoption never scores lower on the same answer.** With a "met", no adoption and an answer decides `pass`, and full adoption now reaches `pass` too. Before this, one bundle-deployed job scored `partial` on the same "met" that scored `pass` for an estate with none.

The answer is recorded on the finding with a third bearing, `co-signed`: the outcome rests on both the measurement and the answer. It is counted as an answered outcome wherever the score reports how much of itself somebody said, and the finding keeps its measurement evidence. An answer that lifts nothing keeps the bearing `record`. A capped finding carries `capped`, so a lift whose answer lapses, or that the final review does not cite, returns to the measured `partial`.

Capped requirements stay on the Answers page whether or not they have been answered, because the lift rests on the answer and the page is where it is renewed. They are optional in a review: a pillar can be confirmed without an answer to one, a counting answer is cited, and a lapsed one is not asked for.

**Reason.** The cap was right and its side effect was not. A resolver that passed a bundle marker as "infrastructure as code" would overread its evidence, so the cap stays. But an answer reached these units only where the app had nothing to measure, so adopting the practice made the score worse than not adopting it on the same answer. Lifting the cap is the answer's only job, which keeps the integrity rule intact: a customer cannot answer away a gap the app measured.

**Governs:**

- `app/server/resolve/resolvers/helpers.ts`: `liftCap`, the one place the lift is decided.
- `app/server/resolve/resolver.ts`: `resolveControl`, which applies the lift before the reason is written, and `withAnswer` and `withoutAnswer`, which apply and take back an answer on a stored finding.
- `app/server/resolve/finding.ts`: `Finding.capped`, the `co-signed` bearing, and `decidedByAnswer`.
- `app/server/resolve/resolvers/operational-excellence.ts` and `app/server/resolve/resolvers/interoperability.ts`: the branches marked `capped`.
- `app/server/review/projection.ts` and `app/server/review/review.ts`: the final review re-applies the answers it cites, and treats a capped requirement as optional.
- `app/server/api/routes.ts`: `attestable()` and `settledByMeasurement`, which keep a capped requirement on the Answers page.
- `app/server/attest/capped-questions.ts`: the question each capped requirement asks.
- `app/server/scan/codec.ts`: codec version 5, which stores `capped` and `co-signed`. Version 4 documents stay readable.
- `app/scripts/methodology-manifest.mts`: the evidence-precedence and cap-lift statements of the methodology.

## D3: OE-03-01 fails when more than 1% of statements waited at a capacity limit

**Status:** decided 2026-10-29 by the product owner

**Decision.** `OE-03-01` (`serviceUsageLimits`) returns `fail` when more than 1% of the statements in the window waited at a capacity limit. Up to 1%, and more than none, is `partial` as a measured shortfall. None waiting is `partial` as a cap that a "met" lifts (D2). No query history is not applicable.

The band is declared in the catalogue `thresholds` and read over the share of statements that did not wait, so it reads in the direction every other band does: `pass_share: 1` is the edge of "none waited" and `partial_share: 0.99` is the edge of "1%". `check:thresholds` now fails when a declared band cannot change the outcome. A band whose pass line is 0 or less, above 1, or not above its partial line, or whose partial line is 0 or less, leaves an outcome no share can reach. The check judges the band a control is scored on: the catalogue's declaration over the resolver's compiled-in fallback.

**Reason.** The control returned `partial` at 0% and at 100% of statements waiting, and its declared `partial_share` was read and never changed the outcome. A control that cannot fail says nothing about the quota pressure it exists to find. More than 1% of statements waiting is quota pressure that no monitoring practice explains away, so the fail is a measured one and no answer lifts it. A declared number that cannot move an outcome is the same fault as one nobody reads, so the check that catches the second now catches the first.

**Governs:**

- `app/server/resolve/resolvers/operational-excellence.ts`: `serviceUsageLimits`, which applies the band with `bandOutcome`.
- `app/config/controls/enrichment.mjs`: the `OE-03-01` criteria and its `pass_share` and `partial_share`.
- `app/scripts/check-thresholds.ts`: `deadBand` and `deadBands`, and the floor on how many bands the walk can judge.

## D4: DG-01-02 and DG-01-03 score organisational design (revised by A8)

**Status:** decided 2026-10-29 by the product owner. Revised by A8 for the AI half.

**Decision.** `DG-01-02` and `DG-01-03` (`unityCatalogAdoption`, with `DG-01-03` completed by A8) score how the estate is organised. They do not score description coverage, which `DG-01-05` scores in the same pillar. The census says how many catalogs there are and how many distinct owners the tables have (`distinctOwners`).

| Reading of the census | Outcome |
| --- | --- |
| every table is in one catalog | `fail` |
| more than one catalog and `distinctOwners` of 1 or less | `partial` |
| more than one catalog and more than one owner | `pass` |
| no tables | not applicable, or unmeasurable where the empty reading cannot be established |

The sentence still says what this metastore governs and not that it is everything, because the census cannot see a legacy metastore. The two requirements are one alias group, so the unit scores at the worse of the two.

**Reason.** The controls used to pass whenever the metastore held a table. That was an honest sentence about a count, and it left a critical control the app could not fail. The census does show whether the estate was divided and whether ownership is distributed, and those are the observable halves of governing a metastore by design. A single catalog is where every grant, owner and environment boundary has to be made at the schema level or not at all. A single owner means one administrator holds the whole estate. Description coverage is `DG-01-05`'s, and scoring it twice would let one gap move two requirements.

**Governs:**

- `app/server/resolve/resolvers/governance.ts`: `unityCatalogAdoption` and `organisation`, which replace the reference to a planning note that no longer exists.
- `app/config/controls/enrichment.mjs`: the `DG-01-02` and `DG-01-03` criteria and remediation.

## A8: DG-01-03 reads where served custom models are registered

**Status:** decided 2026-10-29 by the product owner

**Decision.** `DG-01-03` is "data and AI assets in one place", so beside the catalog and ownership half of D4 it scores a second half: the share of served custom models registered in Unity Catalog, `customModelsNamedInUc / customModels`. It is read from `sql:serving.model_entities`, the signal `OE-02-08` reads for the same count in `model-lifecycle.ts`.

| Share of served custom models in Unity Catalog | AI half |
| --- | --- |
| 80% or more | `pass` |
| 40% or more, and below 80% | `partial` |
| below 40% | `fail` |
| no custom model is served | not applicable |

- **The worse half decides.** `DG-01-03` takes the weaker of the two halves, and the alias group scores the weaker of it and `DG-01-02`. A well-divided data plane with its models in the workspace registry has two places, and an average would let the good half pay for the other.
- **An enrichment, not a requirement.** The serving inventory is declared as an enrichment of `DG-01-03`, so a statement that failed leaves the catalog half standing and the control measured. `DG-01-02` does not ask for it.
- **The bands are declared.** `pass_share: 0.8` and `partial_share: 0.4` sit in the catalogue `thresholds` of `DG-01-03`, so a reader can see which number to argue with. The product owner confirmed them on 2026-10-29.

**Reason.** The census cannot see an AI asset, and a requirement titled "data and AI assets in one place" that never looked at an AI asset would pass an estate whose models sit outside Unity Catalog access control, lineage and audit. Models served from the workspace registry are the measurable form of that gap. Not applicable when none are served is a different statement from none being registered: with nothing served there is no AI asset to put anywhere.

**Governs:**

- `app/server/resolve/resolvers/governance.ts`: `registeredInUnityCatalog` and `dataAndAiInOnePlace`.
- `app/config/controls/enrichment.mjs`: the `DG-01-03` criteria and `thresholds`.

## D5: restore Version 1, release Version 2, label interim records

**Status:** decided 2026-10-29 by the product owner

**Decision.**

1. **Version 1 is the released artifact, byte for byte.** `version-1.manifest.json` and `version-1.release.json` are the files from the `v0.1.0` release, and the manifest digest is `sha256:30d26e28904afb7e2c95799daef7ee26219c1461728ded11f514435394c99761`. A released version's content is never edited, and nothing can satisfy the freeze check by regenerating it.
2. **A change to what a methodology fingerprints is a new public version.** Version 2 carries the scoring changes made since Version 1. It stays a candidate until the product owner approves and releases it, and a release pins its manifest digest in `RELEASED_MANIFEST_DIGESTS` in the same change.
3. **The interim Version 1 manifest is labelled, not rewritten.** Scans taken while the Version 1 manifest on `main` had been regenerated carry the digest `sha256:3ffb685e36d092c91f52a93a172c1db7e32a2ec5f88f3efdab361390eb0dd71f` under `publicVersion: 1`. Wherever a stamp is shown or compared, that digest on a Version 1 stamp is called the "unreleased interim variant of Version 1". Stored stamps and published results keep the bytes they were written with, and no stored scan is re-scored.
4. **A comparison across public versions is refused.** Version 1 against Version 2, or against the interim variant, is a comparison of different standards. `comparable()` refuses it with a reason that names the versions, and names the interim variant by its label. The same label is used when the interim variant is compared with released Version 1, whose digest differs.
5. **The interim variant cannot be published.** A month whose closing run records the interim digest is refused for publication, whatever state its stamp recorded, because no release ever carried that digest.

**Reason.** Version 1 was released at one digest and then changed under the same name. A reader who sees "Methodology Version 1" has to be able to rely on it meaning one fixed standard, so the released files were restored and the later scoring changes moved to a version of their own. The scans that stamped the changed manifest are true records of what was measured, so they stay as they are and are described accurately instead. Comparing them with released Version 1 or with Version 2 would draw a trend across scoring that differs, which is what the methodology barrier exists to refuse.

**Governs:**

- `app/config/methodology/version-1.manifest.json` and `version-1.release.json`: restored from `v0.1.0` and never regenerated.
- `app/config/methodology/version-2.release.json` and `version-2.manifest.json`: the candidate, regenerated with `npm run methodology:manifest` whenever what the manifest fingerprints changes, and released by the product owner with `npm run methodology:release`.
- `app/scripts/methodology-release-policy.ts`: `RELEASED_MANIFEST_DIGESTS`, the pinned digest of every released version, and the freeze check that a regenerated or state-flipped manifest cannot satisfy.
- `app/shared/api/methodology-interim.ts`: the interim digest, its label, and the one test for it.
- `app/shared/api/comparability.ts`: `methodologyBarrier`, which refuses a comparison across public versions or digests and names the interim variant.
- `app/client/src/methodology-identity.ts`, `app/client/src/pages/methodology-language.ts` and `app/client/src/pages/MethodologyPage.tsx`: the stamp label on run and report stamps, and the Methodology page wording for a release or a candidate.
- `app/server/api/publication-routes.ts`: `methodologyRefusal`, which refuses a month closed on the interim variant.

## D8: an optional AI layer is planned, is not yet available, and will never change a finding or score

**Status:** decided 2026-10-29 by the product owner

**Decision.** Public text says what ships. No AI layer is available today. Where the repository mentions one, it says that an optional AI layer is planned and not yet available, and that it will never be able to change a finding or a score. Decision records are cited by their heading on this page, not by an external document.

**Reason.** `app/server/ai/gateway.ts` is not wired into any route, so a sentence saying the AI layer "can explain and prioritise findings" described something a reader cannot use. The boundary that matters, that scoring is deterministic and rests on collected evidence and recorded answers, holds today and is worth stating without promising a feature.

**Governs:**

- `README.md` and `SECURITY.md`: the trust and data boundary wording.
- `CONTRIBUTING.md` and `docs/contributing.md`: the catalogue and scoring rule for contributors.
- `app/server/ai/gateway.ts`: present and tested, and not reachable from any route.

## A2: estate reads act as the signed-in user, the app's service principal owns Lakebase, and schedules use a dedicated service principal

**Status:** decided 2026-10-29 by the product owner

**Decision.** There are three identities, each used for one purpose.

1. Reads of the estate run on behalf of the signed-in user, with the 8 user API scopes the App declares: `sql.statement-execution`, `sql.warehouses:read`, `catalog.catalogs:read`, `catalog.schemas:read`, `catalog.tables:read`, `model-serving`, `vector-search` and `sql.query-history:read`. The App never requests `all-apis`.
2. The App's own service principal owns and writes the Lakebase schema.
3. A scheduled run reads as a dedicated service principal chosen by the installer, whose identity is recorded on the run (see A9).

A workspace admin may restrict which scopes apps can request, and the install guide says so and lists the 8.

**Reason.** A reader's own grants decide what an interactive run can see, so the App cannot be used to read more than the person could. The scopes are named by API family so that settings, authentication, clusters and secrets stay out of reach. The service principal that owns the schema is the identity that writes to it, which avoids a role that can connect and then be refused on its own tables.

**Governs:**

- `app/databricks.yml`: `user_api_scopes`, the list the install guide reproduces.
- `app/app.yaml`: the scopes the App declares.
- `app/scripts/lifecycle.mjs`: the check that the effective scopes match the manifests.
- `docs/install.md` and `docs/configuration.md`: the scope list and the admin restriction note.

## A5: one install per region, in a governance workspace

**Status:** decided 2026-10-29 by the product owner

**Decision.** Install the App once per region, in a governance workspace. The App stores one set of governance records for the estate it assesses.

**Reason.** The records are the product's output: assessments, reviews, publications and improvement actions. Several installs in one region would split them across databases that cannot be compared or published together.

**Governs:**

- `docs/install.md`: the "Where to install" section.

## A11: the estate score is the unweighted mean of the pillar scores, shown with its range and coverage

**Status:** decided 2026-10-29 by the product owner

**Decision.** The overall figure is the unweighted mean of the pillar scores that scored. It is always shown with its range and with the share of applicable requirements that were evaluated, and it is not weighted toward better-measured pillars.

**Reason.** One large pillar cannot dominate a mean of pillars, and weighting toward what was measured would flatter an estate for being unreadable. Showing the range and the coverage next to the figure tells a reader how much of it rests on measurement.

**Governs:**

- `app/server/score/score.ts`: `Score.overall` and `Score.range`.
- `app/client/src/pages/OverviewPage.tsx`, `app/client/src/components/coverage.ts` and `app/client/src/components/score-range.ts`: the posture panel, which shows coverage and the range beside the figure.

## A14: unkeyed digests detect accidental change, and tamper evidence comes from governance history held in Unity Catalog

**Status:** decided 2026-10-29 by the product owner

**Decision.** The SHA-256 digest stamped on a stored record detects a change made by accident or behind the App's back, and identifies an exported document. It is not keyed, so a person who can write the database can change a record and recompute its digest. The App does not describe it as tamper evidence. Tamper evidence comes from keeping the governance history in Unity Catalog, outside the App's own database, which is planned.

**Reason.** Nothing in a record digest is secret, so it cannot prove who wrote a record. Saying so keeps a recipient from trusting it for more than it gives.

**Governs:**

- `app/server/records/digest.ts` and `app/server/records/verify.ts`: what the digest does and does not establish.
- `SECURITY.md`: the statement of what the digest does not buy.

## A17: schema migrations stay additive and backward compatible

**Status:** decided 2026-10-29 by the product owner

**Decision.** A schema change adds tables, columns and indexes. It never drops, renames or changes the type of anything that an earlier version reads or writes.

**Reason.** A rolling deploy runs two versions of the App against one database at once, and a rollback runs the earlier version against the schema the later one migrated. Either version has to work on the schema as it stands.

**Governs:**

- `app/server/store/postgres.ts`: the schema the App creates on boot.
- `CONTRIBUTING.md` and `docs/contributing.md`: the contributor rule.

## A22: evidence that is collected and held is disclosed in the coverage ledger

**Status:** decided 2026-10-29 by the product owner

**Decision.** The administrator script collects evidence for 16 requirements that the App does not yet read back. That is accepted and disclosed: the coverage ledger names them as "Collected, held", and the answer to each remains the person's. Reading them back is planned for a later methodology version, highest severity first.

**Reason.** Holding the readings and naming them keeps the import lossless and keeps the ledger honest about what is scored. Reviving them changes what is scored, which needs a new methodology version rather than a documentation change.

**Governs:**

- `docs/coverage-ledger.md`: the three states of administrator script evidence and the per-requirement table.
