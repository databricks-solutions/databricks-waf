---
title: Detailed DAB lifecycle
description: The complete executable install, upgrade, rollback, recovery and uninstall contract.
permalink: /deployment-lifecycle/
eyebrow: Operator runbook
---

# Deploying and operating the app through DABs

This is the supported install path for the Well-Architected assessment. It owns validation, install,
upgrade, backup, recovery, application rollback and uninstall. The lifecycle commands are deliberately
wrapped around Databricks Declarative Automation Bundles: the app never creates its own grants or
infrastructure.

The commands below are safe to copy from a clean clone. They require an explicit profile and target,
print the resolved actor, workspace and resource plan, and change nothing until `--apply` is supplied.

## Who does what

| Actor                       | Action                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Workspace installer         | Selects the workspace profile, binds the warehouse and Lakebase database, deploys the DAB and approves destructive lifecycle actions |
| Assessment facilitator      | Defines the assessment and runs or reviews it through the signed-in user's OBO permissions                                           |
| Scheduled service principal | Starts only scheduled assessments and reads only the estate grants the installer gives it                                            |
| App service principal       | Runs the server and writes the app's records to the bound Lakebase database                                                          |

The interactive user and scheduled principal are intentionally different identities. The app reports
missing access and setup preflight actions; it never grants access to itself or to either caller.

## 1. Prepare a clean clone and an explicit profile

Install Node.js 22 or later and Databricks CLI 0.292.0 or later, then:

```bash
git clone https://github.com/databricks-solutions/databricks-waf.git
cd databricks-waf
git checkout <release-tag-or-candidate-commit>
cd app
npm ci
databricks --version
databricks auth profiles
databricks current-user me --profile <profile>
```

Choose the profile deliberately. Do not rely on `DEFAULT`, and clear `DATABRICKS_HOST`,
`DATABRICKS_TOKEN` and `DATABRICKS_WAREHOUSE_ID` if they are set: environment credentials override
`--profile` and can send a valid token to a different workspace.

The customer installation uses target `customer`, which contains no workspace ids. Put that
installation's bindings in the ignored file:

`app/.databricks/bundle/customer/variable-overrides.json`

```json
{
  "sql_warehouse_id": "<warehouse-id>",
  "postgres_branch": "projects/<project>/branches/<branch>",
  "postgres_database": "projects/<project>/branches/<branch>/databases/<database-resource-id>",
  "assessor_group": "<direct-membership-group>"
}
```

The warehouse and Lakebase database are customer resources. The DAB binds them with `CAN_USE` and
`CAN_CONNECT_AND_CREATE`; it does not create or own them. The database resource id is not necessarily
the PostgreSQL database name.

The App is stateful, so Lakebase is required. A missing branch or database makes validation fail rather
than permitting an in-memory installation that loses reviews on restart.

## 2. Validate and inspect the DAB plan

```bash
npm run lifecycle -- validate --profile <profile> --target customer
```

This runs `databricks bundle validate` and `databricks bundle plan`, reports the resolved actor,
workspace, App, job and bound data resources, and checks the scheduled identity without changing it.
Resolve every missing required variable or authentication error before continuing.

The scheduled job is installed paused. Leaving its variables empty is a supported interactive-only
installation, not a half-configured schedule.

## 3. Install

Preview first:

```bash
npm run lifecycle -- install --profile <profile> --target customer
```

Then apply the same reviewed plan:

```bash
npm run lifecycle -- install --profile <profile> --target customer --apply
```

The applied command performs the complete Apps/DAB sequence:

1. validate the selected target;
2. produce the DAB resource plan;
3. deploy with active-run protection;
4. run the DAB App resource so configuration is applied and the App restarts;
5. read the deployed App back from the platform;
6. verify `RUNNING`, a successful active deployment, both bindings and every declared effective OBO scope;
7. run a second DAB plan and require every managed resource to be unchanged.

The deployment id and App URL printed at the end are the install record. Open Diagnostics in the App
and run the assessment setup preflight before collecting evidence.

## 4. Optional scheduled assessment identity

Create a dedicated service principal and its secret as described in
[`scheduled-scans.md`](scheduled-scans.md). Add only the non-secret references to the same ignored
override file:

```json
{
  "app_url": "https://<app-host>.aws.databricksapps.com",
  "schedule_client_id": "<application-id>",
  "schedule_secret_scope": "waf-schedule",
  "schedule_secret_key": "oauth-secret"
}
```

Never put the OAuth secret in the bundle file. The secret value stays inside the workspace secret scope.

With a client id configured, the lifecycle command invokes the repository's derived grant tool. Preview
the base grant set with the normal validation command. To include metadata visibility for every customer
catalog and the four sharing-configuration grants, use:

```bash
npm run lifecycle -- upgrade --profile <profile> --target customer \
  --schedule-catalogs all --schedule-sharing
```

Apply only after reviewing the exact grant report:

```bash
npm run lifecycle -- upgrade --profile <profile> --target customer \
  --schedule-catalogs all --schedule-sharing --apply
```

The grant set is derived from the statements the app runs. A second applied run issues no new grants.
After a healthy manual job run, unpause the schedule deliberately; deployment never opts a customer into
unattended collection.

## 5. Upgrade

Check out the exact candidate or release being installed and record the current deployment id from
`databricks apps get databricks-waf-assessment --profile <profile> -o json`. Then:

```bash
npm ci
npm run verify
npm run lifecycle -- upgrade --profile <profile> --target customer
npm run lifecycle -- upgrade --profile <profile> --target customer --apply
```

`install` refuses when the App already exists; `upgrade` refuses when it does not. After `bundle run app`,
the lifecycle waits for the exact new deployment created by that command to become active and refuses a
failed or concurrently replaced deployment. Only then does the post-deploy read guard against an Apps
update silently dropping OBO scopes or changing either binding.

Application rollback and data recovery are separate procedures. Do not use application rollback as a
substitute for a backup.

## 6. Application rollback

Use a clean checkout of the previously approved tag or commit. The rollback command verifies that the
current `HEAD` is exactly the ref named by `--to` and that the app working tree has no tracked or
unignored untracked changes; it never changes the checkout for you.

First preview it:

```bash
npm run lifecycle -- rollback --profile <profile> --target customer --to <previous-tag-or-commit>
```

Then guard the replacement with the deployment id currently serving:

```bash
npm run lifecycle -- rollback --profile <profile> --target customer \
  --to <previous-tag-or-commit> \
  --from-deployment <current-deployment-id> \
  --apply
```

The same running-state, binding, scope and no-change-plan checks run after rollback. If the active
deployment changed between preview and apply, rollback refuses instead of replacing somebody else's
deployment.

## 7. Back up and recover Lakebase records

The recovery archive covers the App-owned `waf` schema in the Lakebase Autoscaling database resolved
from the same explicit DAB target. All current durable customer records are in that schema; the versioned
manifest records an explicit empty `durableUnityCatalogArtifacts` list. Add any future durable UC
artefact to this contract before relying on the command for that release.

Use a private directory outside the repository. Backup refuses an existing archive, a relative or
in-repository path, and a directory accessible to group or other users. Prefer GPG encryption:

```bash
mkdir -m 700 <private-backup-directory>
npm run recovery -- backup --profile <profile> --target customer \
  --archive <absolute-path>.dump.gpg \
  --retain-until <yyyy-mm-dd> \
  --gpg-recipient <recipient> \
  --expect-result <final-assessment-id> \
  --expect-review <assessment-review-id> \
  --expect-action <improvement-action-id>
```

Review the resolved workspace, database, endpoint, App role, record counts and digest, then add `--apply`.
`--plaintext-ok` may replace `--gpg-recipient` only when the operator explicitly accepts a private
mode-`0600` plaintext archive. `pg_dump` uses one serializable, deferrable snapshot of the `waf` schema;
the manifest records before/after fingerprints and whether the source stayed stable across the archive.
Those three named records are mandatory evidence for the complete fresh-install rehearsal. After the
installation has produced a real closed-month publication, `--expect-publication <month-publication-id>`
adds it to a later rehearsal. Do not fabricate or backdate a publication to satisfy recovery evidence.
A backup without the three fresh-install records is still operationally valid, but reports that the
customer-journey evidence set is incomplete.

Restore never writes over the bound database. Supply a new Lakebase database resource id, preview, then
apply:

```bash
npm run recovery -- restore --profile <profile> --target customer \
  --archive <absolute-path>.dump.gpg \
  --database-id <new-recovery-database-id>

npm run recovery -- restore --profile <profile> --target customer \
  --archive <absolute-path>.dump.gpg \
  --database-id <new-recovery-database-id> \
  --apply
```

The applied command creates an empty database through the Lakebase Autoscaling API. A deterministic
no-login role owns the restored objects and is granted only to the operator and App PostgreSQL role; the
database is transferred to that owner through the Lakebase control plane before `pg_restore` runs in one
transaction. Verification requires the original schema/table/constraint fingerprint, every stored
application-record digest, App membership in the owner role, and every named final assessment, review,
action and any optional publication in the manifest. Failed targets and their owner role are retained for inspection.
The private restore receipt records both resource names, archive digest and the full inspection.

For schema-upgrade recovery, keep the serving App and original database unchanged while restoring the
pre-upgrade archive. Check out the previously approved App commit, change only the ignored customer
target's `postgres_database` override to the verified recovery resource, then preview and apply the
[application rollback](#6-application-rollback) against the active deployment id. The DAB path therefore
changes the App binding and code together while the prior application/data pair remains readable.

Recovery cleanup is separately guarded. Preview prints the recovery database, its exact no-login role,
the retained source and archive, and a confirmation token bound to that inventory:

```bash
npm run recovery -- cleanup --profile <profile> --target customer \
  --archive <absolute-path>.dump.gpg \
  --database-id <new-recovery-database-id>
```

Apply only the printed token. Cleanup deletes the named recovery database first and then its dedicated
owner role; if role deletion is interrupted, the same preview/apply flow safely finishes the orphaned
role. Cleanup never deletes the bound source or archive. Keep the archive and manifest through their
recorded retention date, then dispose of them under the customer's backup and legal-hold policy.

## 8. Uninstall

Uninstall is two-step and preserves customer data. Preview it first:

```bash
npm run lifecycle -- uninstall --profile <profile> --target customer
```

The output lists the exact App, Lakeflow Job and bundle workspace path that will be removed. It separately
lists the warehouse, Lakebase branch, Lakebase database and customer records that will remain, then runs
the scheduled-principal revocation as a dry run and prints every direct grant or membership it would
remove. It also prints a confirmation token bound to the bundle, profile, target, workspace host, active
deployment, job id and complete removal/retention/revocation inventory.

Only then apply the exact token:

```bash
npm run lifecycle -- uninstall --profile <profile> --target customer \
  --confirm '<confirmation-token-printed-by-preview>' \
  --apply
```

Where a scheduled principal is configured, its directly revocable Unity Catalog grants and assessor-group
membership are removed before `bundle destroy`. App and warehouse permissions are not rewritten by that
tool because Databricks permission updates replace the full access list; after the App has been removed,
review the warehouse ACL and remove the scheduled principal only if no other workload uses that entry.

Delete the Lakebase database, branch, warehouse, service principal or secret scope only under a separate
customer retention decision. The lifecycle command intentionally cannot turn removing the application
into deleting its retained governance record.
