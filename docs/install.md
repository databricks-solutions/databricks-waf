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

## 2. Clone and verify the target identity

```bash
git clone https://github.com/databricks-solutions/databricks-waf.git
cd databricks-waf/app
npm ci
databricks --version
databricks auth profiles
databricks current-user me --profile <profile>
```

Always pass the intended profile. Environment variables such as `DATABRICKS_HOST`, `DATABRICKS_TOKEN`, `DATABRICKS_CLIENT_ID` and `DATABRICKS_CONFIG_PROFILE` take precedence over `--profile`; the lifecycle wrapper removes them before invoking the CLI so the reviewed profile remains authoritative.

## 3. Record the customer bindings

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

## 4. Validate without changing the workspace

```bash
npm run lifecycle -- validate --profile <profile> --target customer
```

Validation prints the resolved user, workspace, App, scheduled job, warehouse, Lakebase branch and database. It runs `databricks bundle validate` and `databricks bundle plan` but does not apply a change.

Resolve every missing variable, authentication error or resource mismatch before continuing. The optional scheduled job is installed paused; empty schedule variables are a valid interactive-only installation.

## 5. Preview and apply the install

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

## 6. Check the installation in the App

1. Open the App URL in current Chrome.
2. Open **Utilities → Diagnostics**.
3. Confirm Database, Audit trail and Identity are answering.
4. If the warehouse is degraded, open **Checks** from Diagnostics and resolve the named statement or grant.
5. Open **Utilities → Start here** for the guided readiness path.

An App may be healthy while a particular collector lacks access. That condition is reported as a measurement gap; it is never converted into a pass.

## 7. Prepare the first assessment

Open **Assess → Prepare assessment** and provide:

- a meaningful name and purpose;
- accountable owners;
- every visible workspace or an explicit workspace selection;
- the lookback window for usage, job and query evidence;
- all pillars or a selected subset;
- the intended human evidence sources; and
- optional target posture and date for each pillar.

Confirm the definition. The saved definition becomes the repeatable scope for later interactive and scheduled runs.

## 8. Run the first assessment

Select **Run assessment** from the header. Choose the saved definition or a one-off custom scope, then choose all included pillars or a subset. Nothing starts until **Start assessment** is selected.

The Dashboard shows indicative automated posture as soon as collection completes. Publication waits for the selected pillars to be reviewed.

## Optional schedule

Finish an interactive run first. Then follow [Configure scheduled assessments]({{ '/configuration/#scheduled-assessments' | relative_url }}). Deployment never unpauses the schedule for you.

## Next

[Configure every supported setting →]({{ '/configuration/' | relative_url }})

