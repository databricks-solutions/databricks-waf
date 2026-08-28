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
- Cloud credentials, when required, are short lived and vended at scan time; they are not persisted.
- SQL values are parameterised. Identifiers that cannot be parameterised are validated before interpolation.
- The App requests enumerated API scopes and never requests the blanket `all-apis` scope.
- Optional AI receives only the current assessment context and cannot alter findings or scores.

Stored records carry SHA-256 digests of their canonical JSON. These detect accidental or uncoordinated
changes; they are not signatures and do not establish who produced a record. Exports similarly expose a
digest that establishes byte integrity, not origin authenticity.

## Supported versions

Security fixes are applied to `main`. Customer installations are pinned until an operator deliberately
upgrades through the documented DAB lifecycle.
