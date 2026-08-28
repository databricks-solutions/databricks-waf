---
title: Operate, upgrade and recover
description: Health, scheduling, upgrades, backups, restore, rollback, retention and uninstall.
permalink: /operations/
eyebrow: Use the app
---

# Operate, upgrade and recover

Use the lifecycle wrapper for every DAB change and the recovery wrapper for customer records. Both commands preview first and require an explicit apply for mutation.

## Daily and weekly operation

- Open **Next actions** for incomplete reviews, contradicted work, overdue actions, expiring exceptions and partial scheduled runs.
- Open **Diagnostics** when a dependency or evidence collector needs attention.
- Open **Runs** for exact interactive and scheduled execution records.
- Open **Audit trail** when you need the actor, action, target and outcome of a mutation.
- Re-run the assessment after changes; an action marked done is verified only when later evidence meets its requirement.

## Scheduled run supervision

The deployed job contains two tasks:

1. **readiness** checks identity, App access and bindings without retrying settled permission faults;
2. **assess** starts or rejoins the idempotent scan and may retry transient failure.

The schedule is weekly at 06:00 UTC on Monday, deployed paused, and limited to one concurrent run. Review the job's run-as identity, notification recipient and assessment id before unpausing it.

The App reports the current schedule policy and platform run state. It does not predict whether a future platform retry will occur.

## Upgrade

Check out the exact release or candidate and record the currently active deployment id:

```bash
databricks apps get databricks-waf-assessment --profile <profile> -o json
cd app
npm ci
npm run verify
npm run lifecycle -- upgrade --profile <profile> --target customer
npm run lifecycle -- upgrade --profile <profile> --target customer --apply
```

`install` refuses an existing App and `upgrade` refuses a missing one. Upgrade waits for the exact deployment it created and re-verifies state, scopes and bindings before accepting the release.

## Back up Lakebase records

Backups cover the App-owned `waf` schema. Use a private directory outside the repository; encrypted archives are preferred.

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

Review the resolved workspace, database, endpoint, record counts and digest, then add `--apply`. A mode-`0600` plaintext archive requires the explicit `--plaintext-ok` alternative.

The archive includes a manifest, source fingerprints and application-record digests. It contains customer governance data and must follow the customer's encryption, access, retention and legal-hold policy.

## Restore without overwriting the source

Restore always targets a new Lakebase database resource id:

```bash
npm run recovery -- restore --profile <profile> --target customer \
  --archive <absolute-path>.dump.gpg \
  --database-id <new-recovery-database-id>

npm run recovery -- restore --profile <profile> --target customer \
  --archive <absolute-path>.dump.gpg \
  --database-id <new-recovery-database-id> \
  --apply
```

Verification checks the schema, tables, constraints, stored digests, ownership and every expected customer-journey record. The original bound database and serving App remain unchanged during the rehearsal.

To serve the recovered database, check out the previously approved App source, change only `postgres_database` in the ignored customer override, then run the guarded application rollback below.

## Application rollback

Rollback never changes the checkout for you. Use a clean checkout whose `HEAD` is exactly the ref passed to `--to`:

```bash
npm run lifecycle -- rollback --profile <profile> --target customer \
  --to <previous-tag-or-commit>

npm run lifecycle -- rollback --profile <profile> --target customer \
  --to <previous-tag-or-commit> \
  --from-deployment <current-deployment-id> \
  --apply
```

If the serving deployment changed between preview and apply, rollback refuses the replacement. Application rollback and data restore are separate decisions.

## Clean up a recovery rehearsal

Preview cleanup to obtain a confirmation token bound to the exact recovery database and owner role:

```bash
npm run recovery -- cleanup --profile <profile> --target customer \
  --archive <absolute-path>.dump.gpg \
  --database-id <new-recovery-database-id>
```

Apply only the printed token. Cleanup removes the recovery database and its dedicated role; it does not delete the source database or archive.

## Retention

The Retention page shows the current policy and eligible records before a sweep. Treat retention as a governance decision: confirm backup and legal-hold requirements first. Deletion order respects record dependencies so a parent run is not removed while a retained result still references it.

## Uninstall

Uninstall removes bundle-managed application resources and preserves customer data:

```bash
npm run lifecycle -- uninstall --profile <profile> --target customer
```

The preview prints the exact App, job, workspace path, scheduled-principal revocations and retained warehouse, Lakebase branch, database and records. Apply the confirmation token it prints:

```bash
npm run lifecycle -- uninstall --profile <profile> --target customer \
  --confirm '<printed-confirmation-token>' \
  --apply
```

Deleting the retained database, branch, warehouse, service principal, secret scope or backup is a separate customer decision. The uninstall command intentionally cannot turn App removal into deletion of the governance record.

## Canonical runbooks

- [Detailed DAB lifecycle]({{ '/deployment-lifecycle/' | relative_url }})
- [Detailed scheduled-assessment setup]({{ '/scheduled-scans/' | relative_url }})
- [Security boundary](https://github.com/databricks-solutions/databricks-waf/blob/main/SECURITY.md)

## Next

[Troubleshoot the installation →]({{ '/troubleshooting/' | relative_url }})

