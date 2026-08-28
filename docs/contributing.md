---
title: Issues and pull requests
description: How to ask for help, report defects, propose changes and contribute safely.
permalink: /contributing/
eyebrow: Collaborate
---

# Issues and pull requests

Contributions are welcome. Keep the customer outcome explicit, protect customer information, and make the evidence for a change easy to review.

By participating, you agree to the repository [Code of Conduct](https://github.com/databricks-solutions/databricks-waf/blob/main/CODE_OF_CONDUCT.md).

## Get help or report a problem?

| Need | Channel |
| --- | --- |
| Installation or usage question | Read [Troubleshooting]({{ '/troubleshooting/' | relative_url }}), then open a support question if it remains unresolved. |
| Reproducible defect | Open a bug report. |
| New capability or behavior change | Open a feature request before a large implementation. |
| Incorrect or unclear guide content | Open a documentation issue. |
| Security vulnerability | Use GitHub's private **Report a vulnerability** flow. Never open a public issue. |
| Databricks platform security issue | Email `security@databricks.com`. |

## Raise an issue

Search [open and closed issues](https://github.com/databricks-solutions/databricks-waf/issues) first. Then choose the matching issue form.

A useful bug report includes:

- the release tag or commit;
- whether this was install, upgrade, interactive use or a scheduled run;
- the selected assessment scope and page;
- exact steps that reproduce the behavior;
- expected and observed results;
- current Chrome version for UI issues; and
- redacted logs or a screenshot when it adds evidence.

Do not include workspace hostnames, customer names, user emails, tokens, OAuth secrets, database contents, private assessment evidence or unredacted logs. Replace identifiers consistently so relationships remain understandable.

Feature requests should state the user, problem and desired outcome before proposing UI or implementation. Explain how the request fits the prepare → collect → review → publish → improve cycle and whether it affects scoring, evidence provenance or permissions.

## Before you code

For a substantial change, open an issue and agree the product shape first. This avoids a technically complete pull request that changes methodology, security or information architecture in a way maintainers cannot accept.

Read the relevant repository standards:

- `docs/design/customer-design-system.md` for customer-facing layout and language;
- `docs/design/guidance-authoring.md` for recommendation content;
- `docs/coverage-ledger.md` for control and evidence-path changes;
- `SECURITY.md` for identity, scope and storage boundaries; and
- this guide's configuration and operating contracts for deployment changes.

## Fork and create a branch

```bash
git clone https://github.com/<your-user>/databricks-waf.git
cd databricks-waf
git remote add upstream https://github.com/databricks-solutions/databricks-waf.git
git fetch upstream
git switch -c <short-purpose> upstream/main
cd app
npm ci
```

Keep a branch focused on one reviewable outcome. Do not mix dependency updates, visual redesign and unrelated refactoring into the same pull request.

## Build and verify

Change source and tests together. From `app/`:

```bash
npm run verify
```

If client or server source changed, regenerate and commit the production bundle before verification:

```bash
npm run bundle
npm run verify
```

The repository intentionally commits `app/dist/` and `app/client/dist/`; Databricks Apps runs that committed output without a build step.

### Customer experience changes

Run the App locally and inspect every affected production composition in current Chrome at supported laptop and desktop widths, in light and dark themes:

```bash
npm run dev
# another terminal
npm run check:viewport
npm run check:a11y
npm run check:drill
```

Update visual baselines only after reviewing the rendered change. Tablet and mobile support is outside the product scope.

### Catalogue, scoring or SQL changes

Every control must declare provenance, applicability, measurability and evidence path. AI may explain or prioritise but may not determine a finding or score. Run:

```bash
npm run validate:catalogue
npm run check:sql-release
npm run check:guidance
```

Change the methodology identity when a change alters what is scored. A result set must have an enforced bound, and history sources must reduce explicitly to the intended grain.

### Lakebase changes

Unit tests use a strict fake. Verify PostgreSQL behavior against a real disposable schema you control:

```bash
DATABRICKS_CONFIG_PROFILE=<profile> \
LAKEBASE_ENDPOINT=projects/<project>/branches/<branch>/endpoints/<endpoint> \
npm run test:live
```

The live suite creates and removes only its own test schema. Review the target first.

### DAB changes

Use the supported wrapper and an explicit profile and target:

```bash
npm run lifecycle -- validate --profile <profile> --target customer
```

Do not deploy merely to validate ordinary UI work. A real DAB deployment is required when bundle resources, bindings, scopes, runtime configuration or served Databricks integration changed.

### Documentation changes

Keep commands copyable, use placeholders for customer values, and update both the short README path and this guide when an installation contract changes. Run `npm run docs:build` from `app/` and commit the generated HTML with the Markdown source. `npm run verify` refuses stale Pages output; the official repository publishes the pre-rendered `/docs` tree directly because organization policy disables GitHub Actions.

## Open the pull request

Push your branch to your fork and open a pull request against `databricks-solutions/databricks-waf:main`.

The pull request should state:

1. the customer problem and outcome;
2. what behavior changed;
3. tests and visual review performed;
4. security, data, scoring and deployment impact; and
5. documentation or migration required.

Complete the repository pull-request template. Draft pull requests are welcome for early design or API feedback; mark the pull request ready only when its stated checks pass.

## Review and merge

Maintainers review customer behavior, test evidence, security boundaries, methodology impact, generated bundle freshness and documentation. Address review threads with a code or documentation change, or explain concretely why no change is appropriate.

CI passing is necessary, not sufficient. A maintainer merges after the change is reviewable, approved and safe for the public release line. Do not rewrite shared branch history after review has begun unless the reviewers ask for it.

## Security and customer data

Never commit or attach:

- Databricks profiles, tokens or OAuth secrets;
- DAB customer overrides;
- workspace or account identifiers from a customer;
- Lakebase dumps;
- assessment evidence or exports; or
- screenshots and logs containing customer or user identity.

If a credential was pushed, revoke it immediately before attempting to remove it from history, then use the private security channel.
