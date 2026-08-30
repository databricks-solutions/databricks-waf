---
title: Deploy with Genie Code
description: Point Genie Code at this repository and have it deploy the Well-Architected Framework assessment app into your workspace, then self-verify the result.
permalink: /deploy-with-genie-code/
eyebrow: Get started
---

# Deploy with Genie Code

This page is written for Genie Code as the agent doing the work. Point Genie Code at this repository
and ask it to deploy the Well-Architected Framework assessment app into the workspace you are in. You
work out the mechanics; this page gives you the objective, the facts specific to this app, and a
self-check so you can confirm you actually succeeded.

This in-workspace route is a convenience; the reviewed, supported path is
[Install the App]({{ '/install/' | relative_url }}).

A person kicks it off with something like:

> Open a notebook attached to a cluster you can run shell commands on, then tell Genie Code:
> *"Deploy the WAF assessment app into this workspace by following the Deploy with Genie Code guide.
> Work out the steps, then run the guide's verification and tell me the verdict."*

## The objective

Deploy the app as a Databricks App in this workspace and leave it running and correctly bound.
"Done" is not "the commands ran"; it is every check in [Verify your work](#verify-your-work) passing.
Verify at the end and report the verdict.

## Confirm before you start

- **Databricks Apps enabled** in the workspace.
- **A cluster you can run shell commands on, with outbound internet** if you deploy from a notebook.
  A dedicated (single-user) cluster is the simplest choice. The shell needs to reach the npm registry
  and the Node and Databricks CLI installers.
- **The identity running the notebook can** create a Lakebase project, use a SQL warehouse, and
  deploy Apps and jobs. Every command acts as that identity.

## Work out the deployment

You decide the exact commands. Reach the objective using these facts, which are specific to this app:

- **Tooling.** The deploy needs Node.js 22+ and Databricks CLI 0.292.0+ in whatever shell you use.
  Install them if they are missing.
- **Authentication.** The lifecycle wrapper removes the standard Databricks auth environment variables
  (`DATABRICKS_HOST`, `DATABRICKS_TOKEN`, `DATABRICKS_CONFIG_PROFILE`, and related) before it calls the
  CLI, so authenticate with a named profile in `~/.databrickscfg` and pass `--profile`; an env-var
  token will not survive. Inside a notebook you can mint a host and token from the notebook context to
  write that profile.
- **The code.** Clone `https://github.com/databricks-solutions/databricks-waf` and run `npm ci` in its
  `app/` directory.
- **The four bindings.** The bundle binds resources you provide; it does not create or delete them.
  Make sure each exists, then record them in `app/.databricks/bundle/customer/variable-overrides.json`:

  ```json
  {
    "sql_warehouse_id": "<a running SQL warehouse id>",
    "postgres_branch": "projects/<project>/branches/<branch>",
    "postgres_database": "projects/<project>/branches/<branch>/databases/<database-id>",
    "assessor_group": "<group whose DIRECT members may run assessments>"
  }
  ```

  A freshly created Lakebase Autoscaling project exposes a database whose resource id is
  `databricks-postgres`. `admins` is a safe default for `assessor_group`; membership must be direct.

- **The deploy command.** From `app/`, the app deploys through its lifecycle wrapper: validate, then a
  dry-run install, then the apply.

  ```bash
  npm run lifecycle -- validate --profile <profile> --target customer
  npm run lifecycle -- install  --profile <profile> --target customer
  npm run lifecycle -- install  --profile <profile> --target customer --apply
  ```

The exact, fully worked command sequence for a shell (clone, resource discovery, provisioning) is in
[Install the App]({{ '/install/' | relative_url }}) and [Detailed DAB lifecycle]({{ '/deployment-lifecycle/' | relative_url }}).
Adapt it to your shell rather than copying it blind.

## Verify your work

Run this yourself and read the result. It uses the Databricks SDK, which authenticates as you inside a
notebook with no profile, so it works even when the deploy ran in a separate `%sh` shell. The app is
correctly deployed only when every check prints `PASS`.

```python
# Python cell. If the SDK is missing: %pip install databricks-sdk  (then restart Python)
from databricks.sdk import WorkspaceClient

APP = "databricks-waf-assessment"
REQUIRED_SCOPES = {
    "sql.statement-execution", "sql.warehouses:read",
    "catalog.catalogs:read", "catalog.schemas:read", "catalog.tables:read",
    "model-serving", "vector-search", "sql.query-history:read",
}

w = WorkspaceClient()
app = w.apps.get(name=APP)

app_state = str(getattr(app.app_status, "state", ""))
dep = app.active_deployment
dep_state = str(getattr(getattr(dep, "status", None), "state", "")) if dep else ""
scopes = set(getattr(app, "effective_user_api_scopes", None) or getattr(app, "user_api_scopes", None) or [])
names = {getattr(r, "name", "") for r in (app.resources or [])}

checks = {
    "app is RUNNING":            app_state.endswith("RUNNING"),
    "deployment SUCCEEDED":      dep_state.endswith("SUCCEEDED"),
    "on-behalf-of scopes bound": REQUIRED_SCOPES.issubset(scopes),
    "SQL warehouse bound":       "sql-warehouse" in names,
    "Lakebase database bound":   "postgres" in names,
}
for label, ok in checks.items():
    print(("PASS" if ok else "FAIL"), "-", label)

missing = REQUIRED_SCOPES - scopes
if missing:
    print("   missing scopes:", sorted(missing))
print("\nVERDICT:", "DEPLOYED CORRECTLY" if all(checks.values()) else "NOT DONE — investigate the FAILs above")
print("app url:", app.url)
```

Then finish with the in-app check the SDK cannot see: open the app URL, go to
**Utilities → Diagnostics**, and confirm Database, Audit trail, and Identity are all answering. That
proves the running app can actually reach its warehouse and Lakebase store, not just that it started.

When every check passes, open **Assess → Prepare assessment** to define and run the first assessment.

## Reading the verdict

- **All `PASS`.** Deployed correctly. The deploy is done regardless of what any single command printed.
- **App RUNNING and scopes and bindings all PASS, but the deploy command exited non-zero.** The
  lifecycle runs a second plan after applying and fails if any resource still shows a change. On a
  first install the leftover diff is commonly just the app object and the scheduled job's permissions
  reconciling, and the app is usable. Trust this verification over the command's exit code, but do not
  ignore a `FAIL` here.
- **`on-behalf-of scopes bound` FAILs.** The app object did not receive its scopes. Re-run the apply so
  the create/update sets them; the bundle is authoritative for the scope list.
- **`app is RUNNING` or `deployment SUCCEEDED` FAILs.** Read `app.active_deployment.status.message` and
  the app logs (`w.apps.get(...)`, or `databricks apps logs <name>`). The usual causes are a binding
  that points at a resource that does not exist, or a Lakebase branch that was not `READY` when the
  bindings were written.
- **A binding FAILs.** The warehouse or Lakebase resource is not attached. Re-check that value in
  `variable-overrides.json` and re-apply.

## If the notebook route will not work

If shell access or egress is blocked, or you hit a wall you cannot clear from the cluster, switch to
the supported path in [Install the App]({{ '/install/' | relative_url }}). It does not depend on the
cluster at all: clone to a laptop or a web terminal with Node 22 and the Databricks CLI, and it uses
the same bindings file and the same `npm run lifecycle` commands described above. The verification cell
in this guide works the same way afterward.
