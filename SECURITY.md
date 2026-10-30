# Security policy

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Report Databricks platform issues to
<security@databricks.com>. For a project-specific issue, use this repository's private
**Security → Advisories → Report a vulnerability** flow.

Include the affected version or commit, reproduction steps and expected impact.

## Security boundary

The App reads Databricks configuration and telemetry and writes assessment records to a Lakebase database
owned by the installing customer.

- It never asks for, receives or stores a personal access token. The Databricks Apps proxy supplies a
  short-lived on-behalf-of token for the current request.
- Interactive reads run with the signed-in user's permissions. Scheduled reads run as the explicitly
  configured service principal, whose identity is recorded on the run.
- Mutating endpoints fail closed unless the caller is a direct member of the configured assessor group.
- Stored results are shared as described under *Who can read stored results* below: outcomes, scores and
  summaries to every app user, and the detail behind them to direct members of the assessor group only.
- Cloud credentials, when required, are short lived and vended at scan time; they are not persisted.
- SQL values are parameterised. Identifiers that cannot be parameterised are validated before interpolation.
- The App requests enumerated API scopes and never requests the blanket `all-apis` scope.
- Optional AI receives only the current assessment context and cannot alter findings or scores.

## Who can read stored results

A run reads the estate as the person or service principal who started it, so a stored result holds what
that identity could read, which is not necessarily what the person opening it later could read. The App
therefore does not treat the ability to open it as the ability to read everything a run stored
(decision D1 in `docs/decisions.md`).

Every person who can open the App can read published results, scores, finding outcomes and summaries.
Only direct members of the group named by `assessor_group` (`WAF_ASSESSOR_GROUP`) can read:

- the text of a statement, in advisories;
- the principal identifiers in a finding's evidence: the holders of personal access tokens and the
  accounts that jobs run as; and
- the raw readings an administrator imported, and the name of whoever collected them.

Everyone else is shown a placeholder in each place, which says the field is withheld and names the group.
A request with no forwarded token, or one whose identity lookup fails or lists no groups, is treated as
outside the group. The same rule applies to the CSV and JSON exports, so a file carries the placeholders
that the page shows and its digest is the digest of that file. The projection runs when a record is read:
stored records and the digests written with them are not altered. There is no per-row access control, and
the policy does not change what is collected or stored.

Stored records carry SHA-256 digests of their canonical JSON. These detect accidental or uncoordinated
changes; they are not signatures and do not establish who produced a record. Exports similarly expose a
digest that establishes byte integrity, not origin authenticity.

## Supported versions

Security fixes are applied to `main`. Customer installations are pinned until an operator deliberately
upgrades through the documented DAB lifecycle.
