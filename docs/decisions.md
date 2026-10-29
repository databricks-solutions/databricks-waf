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
