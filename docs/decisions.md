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
