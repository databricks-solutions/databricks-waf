---
title: Install the App
description: Prepare Databricks resources and install the WAF assessment through the supported DAB lifecycle.
permalink: /install/
eyebrow: Get started
---

# Install the App

The supported path is a reviewed Databricks Asset Bundle plan followed by an explicit apply. The installer chooses the workspace, warehouse, Lakebase database and assessor group; the repository contains no customer resource identifiers.

## 1. Prerequisites

You need:

- A Databricks workspace with Databricks Apps enabled.
- Databricks CLI 0.292.0 or later and an authenticated workspace profile.
- Node.js 22 or later.
- A running SQL warehouse the assessment identities may use.
- A Lakebase Autoscaling branch and database.
- A Databricks group whose **direct members** may start scans, answer requirements, review pillars and manage improvement records.
- Permission to deploy Apps and jobs and bind the selected resources.

The DAB binds existing customer resources. It does not create the warehouse, Lakebase project, branch or database.

## 2. Choose where to install

Install the App once per region, in a governance workspace: a workspace set aside for governance work in that region. One install keeps one set of governance records for the estate it assesses, so avoid running several copies in the same region, which would split those records. See decision A5 in [Product decisions]({{ '/decisions/' | relative_url }}).

## 3. Clone and verify the target identity

```bash
git clone https://github.com/databricks-solutions/databricks-waf.git
cd databricks-waf/app
npm ci
databricks --version
databricks auth profiles
databricks current-user me --profile <profile>
```

Always pass the intended profile. Environment variables such as `DATABRICKS_HOST`, `DATABRICKS_TOKEN`, `DATABRICKS_CLIENT_ID` and `DATABRICKS_CONFIG_PROFILE` take precedence over `--profile`; the lifecycle wrapper removes them before invoking the CLI so the reviewed profile remains authoritative.

## 4. Confirm the API scopes the App requests

The App acts as the signed-in user with these 8 user API scopes, declared as `user_api_scopes` in `app/databricks.yml`:

| Scope | What it permits |
| --- | --- |
| `sql.statement-execution` | Run the assessment's read statements on the bound warehouse. |
| `sql.warehouses:read` | Read warehouse state and configuration. |
| `catalog.catalogs:read` | Read Unity Catalog catalogs. |
| `catalog.schemas:read` | Read Unity Catalog schemas. |
| `catalog.tables:read` | Read Unity Catalog tables. |
| `model-serving` | Read served model and endpoint information. |
| `vector-search` | Read vector search endpoint and index information. |
| `sql.query-history:read` | Read query history and plans for the workload advisor. |

The App never requests `all-apis`. A scope permits an API family; the signed-in person's own workspace and Unity Catalog grants still decide what can be read.

A workspace admin can restrict the scopes an app may request. If the workspace restricts them below this list, the App cannot act with the full list. Ask the admin to allow all 8 before installing. The lifecycle command checks the effective scopes against the manifests and fails the install when they differ. See decision A2 in [Product decisions]({{ '/decisions/' | relative_url }}).

## 5. Set the Lakebase options

Set these on the Lakebase project and branch you are about to bind, before you deploy:

- **History window: 30 days.** The documented range is 2 to 30 days and the default is 7. Use 30 so point-in-time restore reaches back a full month.
- **Protect the production branch**, so it cannot be deleted by mistake.
- **Take a manual snapshot before each upgrade**, so there is a known restore point that predates the new version.
- **Keep recovery archives in a governed Unity Catalog Volume.** `npm run recovery -- backup` writes an archive to a local path; copy or upload it into the governed Volume afterwards. Archives contain governance records and must sit under the customer's access, retention and legal-hold controls. See [Operate, upgrade and recover]({{ '/operations/' | relative_url }}).

## 6. Record the customer bindings

Create this ignored local file:

`app/.databricks/bundle/customer/variable-overrides.json`

```json
{
  "sql_warehouse_id": "<warehouse-id>",
  "postgres_branch": "projects/<project>/branches/<branch>",
  "postgres_database": "projects/<project>/branches/<branch>/databases/<database-resource-id>",
  "assessor_group": "<direct-membership-group>"
}
```

Use the Lakebase **resource id**, not the PostgreSQL database name. A new project commonly uses resource id `databricks-postgres` while the PostgreSQL database is named `databricks_postgres`.

Do not commit this file. Never place a personal access token, OAuth secret or customer data in the repository.

## 7. Validate without changing the workspace

```bash
npm run lifecycle -- validate --profile <profile> --target customer
```

Validation prints the resolved user, workspace, App, scheduled job, warehouse, Lakebase branch and database. It runs `databricks bundle validate` and `databricks bundle plan` but does not apply a change.

Resolve every missing variable, authentication error or resource mismatch before continuing. The optional scheduled job is installed paused; empty schedule variables are a valid interactive-only installation.

## 8. Preview and apply the install

Preview the complete plan:

```bash
npm run lifecycle -- install --profile <profile> --target customer
```

Apply the same reviewed plan:

```bash
npm run lifecycle -- install --profile <profile> --target customer --apply
```

The lifecycle command deploys the bundle, applies and restarts the App resource, waits for the new deployment, and verifies:

- App state is `RUNNING` and the active deployment succeeded;
- the effective on-behalf-of scopes exactly match the manifests;
- the warehouse and Lakebase bindings match the reviewed plan; and
- a second DAB plan reports no remaining changes.

Keep the printed deployment id and App URL as the installation record.

## 9. Check the installation in the App

1. Open the App URL in current Chrome.
2. Open **Utilities → Diagnostics**.
3. Confirm Database, Audit trail and Identity are answering.
4. If the warehouse is degraded, open **Checks** from Diagnostics and resolve the named statement or grant.
5. Open **Utilities → Start here** for the guided readiness path.

An App may be healthy while a particular collector lacks access. That condition is reported as a measurement gap; it is never converted into a pass.

## 10. Set up telemetry, budget and warehouse

- **Enable app telemetry export**, so the App's operational telemetry can be watched outside the App.
- **Put budget policies and tags on the App, Lakebase and the warehouse**, so the cost of the assessment can be reported and capped on its own.
- **Use a small serverless SQL warehouse with auto-stop**, changing the bound warehouse if it is larger or does not stop on its own. The App's statements are bounded reads and one scan runs at a time, so a small warehouse is enough, and auto-stop keeps it from running between scans.

## 11. Prepare the first assessment

Open **Assess → Prepare assessment** and provide:

- a meaningful name and purpose;
- accountable owners;
- every visible workspace or an explicit workspace selection;
- the lookback window for usage, job and query evidence;
- all pillars or a selected subset;
- the intended human evidence sources; and
- optional target posture and date for each pillar.

Confirm the definition. The saved definition becomes the repeatable scope for later interactive and scheduled runs.

## 12. Run the first assessment

Select **Run assessment** from the header. Choose the saved definition or a one-off custom scope, then choose all included pillars or a subset. Nothing starts until **Start assessment** is selected.

The Dashboard shows indicative automated posture as soon as collection completes. Publication waits for the selected pillars to be reviewed.

## Running more than one instance

The App can run on two or more instances behind the one URL, and Databricks recommends at least two. Horizontal scaling is supported from this release. Every instance reads and writes the same Lakebase database, so they agree on what is running. At most one assessment run and one advisory run are live at a time across all of them: a second request is refused with a `409` that names the run already going, and no run record is written for the refusal. Progress and status are read from the run record, so any instance reports a scan that another started. A rolling deploy that serves the old and new versions side by side is covered from this release onward, because the admission rule needs no schema change. Builds before this release did not take the database admission lock or read the version 5 codec, so the first upgrade from an earlier release onto this one should run as a single instance first. Rolling deploys are covered once every instance runs this release. See decision A16 in [Product decisions]({{ '/decisions/' | relative_url }}).

## Optional schedule

Finish an interactive run first. Then follow [Configure scheduled assessments]({{ '/configuration/#scheduled-assessments' | relative_url }}). Deployment never unpauses the schedule for you.

## Next

[Configure every supported setting →]({{ '/configuration/' | relative_url }})

