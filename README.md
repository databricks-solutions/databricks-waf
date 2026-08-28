# Databricks Well-Architected Framework assessment

A Databricks App that assesses a workspace or account against the seven pillars of the
[Databricks Well-Architected Framework](https://docs.databricks.com/aws/en/lakehouse-architecture/).

It combines automated evidence with explicit human review, shows what could not be measured, and turns
unmet requirements into owned improvement actions. Automated results provide an indicative pillar score
immediately; a reviewed, immutable assessment becomes the durable report used for governance and trends.

<!-- catalogue-counts:start -->

**165 scored controls** across 7 pillars and 31 principles, of which 115 are automatable.

Every control declares where it came from, so the app can answer "is this the actual
Well-Architected Framework?" without hedging:

| Provenance | Controls | Meaning |
| --- | --- | --- |
| `waf-docs` | 113 | A best practice published on a WAF pillar page, carrying a deep link to it. |
| `security-guide` | 66 | A control from the Databricks security guidance that the WAF security pillar page formally delegates to. The pillar page itself documents only four practices and points elsewhere. |
| `extension` | 5 | Authored by this project, not published Databricks guidance. Each carries a rationale and is labelled as an extension in the UI. |

The table counts 184 catalogue entries against 165 scored controls. The difference is requirements that belong to more than one pillar — Delta history
 retention is both a cost concern and a recovery concern — which appear in each and are
 scored once, so overlap cannot inflate the total. The automatable figure above is counted
 the same way; over all 184 entries it is 134.

<!-- catalogue-counts:end -->

## What the app provides

- Configurable assessment scope: all pillars or a subset, and one workspace or an account-wide selection.
- Automated collection from Databricks system tables and APIs using the signed-in user's permissions.
- Evidence, confidence and coverage for every result—unmeasured is never treated as passing.
- A guided review flow for requirements that need human evidence.
- A permanent Dashboard, printable report, exports, improvement plans and validation history.
- Workload, serverless, storage and serving-readiness analysis linked to concrete actions.
- Optional scheduled assessments through a dedicated service principal.
- Lakebase-backed durable history with executable backup, restore, rollback and uninstall procedures.

The optional AI layer explains and prioritises findings. It cannot alter a score or finding.

## Requirements

- A Databricks workspace with Databricks Apps enabled.
- Databricks CLI 0.292.0 or later.
- Node.js 22 or later.
- A SQL warehouse.
- A Lakebase Autoscaling branch and database.
- A Databricks group whose direct members may run and review assessments.

## Install with Databricks Asset Bundles

Clone the repository and install its dependencies:

```bash
git clone https://github.com/databricks-solutions/databricks-waf.git
cd databricks-waf/app
npm ci
databricks auth profiles
databricks current-user me --profile <profile>
```

Create the ignored local override file at
`app/.databricks/bundle/customer/variable-overrides.json`:

```json
{
  "sql_warehouse_id": "<warehouse-id>",
  "postgres_branch": "projects/<project>/branches/<branch>",
  "postgres_database": "projects/<project>/branches/<branch>/databases/<database-id>",
  "assessor_group": "<direct-membership-group>"
}
```

Validate the resolved identity, workspace, resources and DAB plan:

```bash
npm run lifecycle -- validate --profile <profile> --target customer
```

Preview the install, then apply that reviewed plan:

```bash
npm run lifecycle -- install --profile <profile> --target customer
npm run lifecycle -- install --profile <profile> --target customer --apply
```

The lifecycle command deploys through DABs, starts the App, verifies its deployment, scopes and bindings,
and requires the second bundle plan to be unchanged. See [the deployment lifecycle](docs/deployment-lifecycle.md)
for upgrades, scheduling, backup and restore, rollback and uninstall.

## Security model

- Assessment reads run on behalf of the signed-in user by default.
- Mutations require direct membership in the configured assessor group.
- The App never asks for or stores personal access tokens.
- Lakebase stores application records; the App does not persist credentials.
- API scopes are enumerated in `app/app.yaml` and `app/databricks.yml`.
- Assessment SQL is parameterised and the REST collector is held to read-only routes.

See [SECURITY.md](SECURITY.md) for the complete security boundary and reporting process.

## Develop locally

```bash
cd app
npm ci
npm run dev
```

Run the same source and committed-bundle checks used by CI:

```bash
npm run verify
```

The app is supported on current desktop and laptop Chrome. Tablet and mobile layouts are not supported.
See [CONTRIBUTING.md](CONTRIBUTING.md) for code, browser and DAB verification requirements.

## User guide

The [public user guide](https://databricks-solutions.github.io/databricks-waf/) covers installation,
every supported setting and page, the complete assessment journey, scheduling, recovery,
troubleshooting, issues and pull requests.

## Repository layout

```text
app/                    Databricks App, DAB configuration, source, tests and committed bundle
docs/coverage-ledger.md Control coverage and evidence-path inventory
docs/deployment-lifecycle.md
                        Install, upgrade, recovery, rollback and uninstall runbook
docs/scheduled-scans.md Optional scheduled-identity setup
docs/design/            Customer experience and guidance authoring standards
```

## Licence

&copy; 2026 Databricks, Inc. All rights reserved. The source in this repository is provided subject to
the [Databricks License](https://databricks.com/db-license-source). See [LICENSE.md](LICENSE.md) for
details. Every included third-party package remains subject to its own licence.

The complete production lockfile contains 518 third-party package/version pairs across every optional
runtime platform. All are listed in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md), and CI refuses a
production dependency whose licence is absent or outside the reviewed allowlist.

<!-- third-party-licenses:start -->
<details>
<summary><strong>Third-party licence summary and direct libraries</strong></summary>

| Licence | Resolved production packages |
| --- | ---: |
| MIT | 362 |
| Apache-2.0 | 97 |
| ISC | 27 |
| BSD-3-Clause | 15 |
| MPL-2.0 | 12 |
| 0BSD | 2 |
| (MPL-2.0 OR Apache-2.0) | 1 |
| BSD-2-Clause | 1 |
| Python-2.0 | 1 |

| Direct third-party library | Version | Licence | Source |
| --- | --- | --- | --- |
| @xyflow/react | 12.11.3 | MIT | [npm](https://www.npmjs.com/package/@xyflow/react/v/12.11.3) |
| clsx | 2.1.1 | MIT | [npm](https://www.npmjs.com/package/clsx/v/2.1.1) |
| embla-carousel-react | 8.6.0 | MIT | [npm](https://www.npmjs.com/package/embla-carousel-react/v/8.6.0) |
| express | 5.2.1 | MIT | [npm](https://www.npmjs.com/package/express/v/5.2.1) |
| js-yaml | 5.4.0 | MIT | [npm](https://www.npmjs.com/package/js-yaml/v/5.4.0) |
| lucide-react | 1.34.0 | ISC | [npm](https://www.npmjs.com/package/lucide-react/v/1.34.0) |
| next-themes | 0.4.6 | MIT | [npm](https://www.npmjs.com/package/next-themes/v/0.4.6) |
| react | 19.2.8 | MIT | [npm](https://www.npmjs.com/package/react/v/19.2.8) |
| react-dom | 19.2.8 | MIT | [npm](https://www.npmjs.com/package/react-dom/v/19.2.8) |
| react-resizable-panels | 4.12.3 | MIT | [npm](https://www.npmjs.com/package/react-resizable-panels/v/4.12.3) |
| react-router | 8.3.0 | MIT | [npm](https://www.npmjs.com/package/react-router/v/8.3.0) |
| tailwind-merge | 3.6.0 | MIT | [npm](https://www.npmjs.com/package/tailwind-merge/v/3.6.0) |
| tailwindcss-animate | 1.0.7 | MIT | [npm](https://www.npmjs.com/package/tailwindcss-animate/v/1.0.7) |
| tw-animate-css | 1.4.0 | MIT | [npm](https://www.npmjs.com/package/tw-animate-css/v/1.4.0) |
| zod | 4.4.3 | MIT | [npm](https://www.npmjs.com/package/zod/v/4.4.3) |

First-party `@databricks/*` packages are governed separately by their published Apache-2.0 terms.

</details>
<!-- third-party-licenses:end -->

This repository begins at a reviewed release baseline. The private development history was deliberately
retained outside the distribution repository so internal workspace details and delivery records are not
part of the public Git history.
