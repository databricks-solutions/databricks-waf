---
title: Configuration reference
description: Every customer-facing DAB variable, identity, permission and assessment setting.
permalink: /configuration/
eyebrow: Get started
---

# Configuration reference

Configuration has three layers: customer bindings in the ignored DAB override, an assessment definition in the App, and optional schedule settings. Customer identifiers and secrets do not belong in Git.

## DAB variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `sql_warehouse_id` | Yes | — | Warehouse used for assessment SQL. Bound to the App with `CAN_USE`. |
| `postgres_branch` | Yes | — | Lakebase branch resource name: `projects/<project>/branches/<branch>`. |
| `postgres_database` | Yes | — | Lakebase database resource name inside that branch. |
| `assessor_group` | Strongly recommended | `admins` | Group whose direct members may mutate assessment records and read the detail behind stored results (see [Who can read stored results](#who-can-read-stored-results)). Use a dedicated group so assessors do not need workspace-admin rights. |
| `app_url` | Schedule only | empty | Deployed Databricks Apps URL called by the scheduled job. This is not the workspace URL. |
| `schedule_client_id` | Schedule only | empty | Application id of the dedicated scheduled service principal; not its numeric SCIM id. |
| `schedule_secret_scope` | Schedule only | empty | Workspace secret scope holding that principal's OAuth secret. |
| `schedule_secret_key` | Schedule only | empty | Key within the secret scope. |
| `schedule_assessment_id` | No | empty | Immutable assessment definition the job runs. Empty preserves an ad-hoc scheduled scope. |
| `job_performance_target` | No | `STANDARD` | Serverless job startup profile. Use `PERFORMANCE_OPTIMIZED` only where somebody is waiting for repeated development runs. |

The `customer` target contains no workspace ids. Put variable values in `.databricks/bundle/customer/variable-overrides.json` and select the workspace with `--profile`.

## Runtime contract

The DAB and `app.yaml` deliberately declare the same App environment:

| Runtime value | Source | Meaning |
| --- | --- | --- |
| `DATABRICKS_WAREHOUSE_ID` | `sql-warehouse` binding | Warehouse used by the server's statement executor. |
| `LAKEBASE_ENDPOINT` | `postgres` binding | Platform-resolved Lakebase connection. Required for durable operation. |
| `WAF_ASSESSOR_GROUP` | `assessor_group` | Direct-membership mutation gate, and the group whose direct members are shown restricted detail in stored results. |
| `WAF_AUDIT_STRICT` | Manifest value `0` | What the App does when an action cannot be written to the audit trail. `0` performs the action and records the loss. `1` refuses the action when the trail does not answer, and records the loss when a write fails after it did. See [What happens when an audit event cannot be written](#what-happens-when-an-audit-event-cannot-be-written). |

Do not set these by hand in the deployed App. Change the DAB override and use the supported upgrade command so bundle state and runtime state stay aligned.

### What happens when an audit event cannot be written

The two values of `WAF_AUDIT_STRICT` differ in when the App checks the audit trail, and neither makes the action and its audit event one transaction.

| Value | Before the action | If the audit event cannot be written |
| --- | --- | --- |
| `0` (default) | Nothing is checked. | The action stands. The App counts the loss and leaves a durable marker, so a database blip does not stop somebody answering a requirement. |
| `1` | The App reads the end of the trail. If the trail does not answer, the action is refused and nothing happens. | If the trail answered and the write then failed, the action has already happened and stands. The App counts the loss and leaves the same marker. |

At `1` the check narrows the window and does not close it. An audit event that fails to write after the trail answered cannot be prevented, only recorded. A refusal the gate makes before that check can be lost the same way. The reasoning is in [decision D7](decisions.md#d7-no-transactional-strict-audit-mode-a-lost-audit-event-is-recorded-durably).

A marker holds the time, the action, the actor, what the action was on and the class of the failure. It holds nothing of the action's content. Markers are kept in the database beside the trail, so:

- they survive a restart, which the in-memory count does not;
- every instance of the App reports the same ones, whichever instance lost the event and whichever serves the request;
- Diagnostics lists each one until a member of `assessor_group` acknowledges it. The acknowledgement is itself recorded in the audit trail under that person's name.

Acknowledging says that somebody has looked. It does not recover the event, and the audit trail's verification reads the same chain it did before. The count on the Diagnostics page is labelled as this instance's because it is held in memory: it starts again at zero on a restart and another instance has its own. If the database refuses the marker as well, only that count and the App log remain.

## Interactive identity and permissions

The Databricks Apps proxy provides a short-lived on-behalf-of token for the signed-in user. The App requests only these functional scopes:

- SQL statement execution and warehouse read;
- Unity Catalog catalog, schema and table read;
- model serving and vector search read paths; and
- SQL query history read for workload analysis.

The App does not request `all-apis`, authentication-management, secret-management or cluster-management authority. A scope permits the API family; the caller's workspace and Unity Catalog grants still decide what can be read.

Read-only pages are available to people who can open the App. Starting scans or changing records additionally requires direct membership in `assessor_group`.

### Who can read stored results

Published results, scores, finding outcomes and summaries are readable by everyone who can open the App. The detail behind them is shown only to direct members of `assessor_group`, because a stored run holds what the identity that ran it could read, which can be more than a reader's own grants reach:

| Shown only to assessors | What everyone else sees |
| --- | --- |
| The text of a statement, in advisories | A placeholder naming the group |
| The principal identifiers in a finding's evidence: token holders, and the accounts jobs run as | A placeholder naming the group |
| An administrator's imported readings, and who collected them | A placeholder naming the group |

The placeholder applies in the pages, the API and the CSV and JSON exports alike. A file exported by a reader outside the group therefore differs from the assessor's file, and the digest listed beside each file is the digest of the file that reader downloads. A request with no forwarded token, or one whose identity lookup fails or lists no groups, is treated as outside the group: the summaries are still served and the detail is withheld. Nested group membership does not count, for the reason it does not count for changes. Nothing about collection or storage changes, and the policy is applied when a record is read, so it covers results stored earlier. The reasoning is in [decision D1](decisions.md#d1-stored-results-are-shared-in-full-and-the-detail-behind-them-only-with-assessors).

## Assessment definition settings

An assessment definition records the question a run is expected to answer:

| Setting | Effect |
| --- | --- |
| Name and purpose | Identifies the review and why it exists. Use language that remains meaningful in reports and history. |
| Owners | Accountable teams or people. This is governance metadata, not the mutation permission gate. |
| Workspace scope | Every workspace visible to the scanning identity, or an explicit selection. A user cannot select a workspace the account directory does not expose to that identity. |
| Lookback days | Historical window for usage, query and job evidence. It does not change the selected workspaces. |
| Pillars | One, any subset, or all seven framework pillars. |
| Evidence sources | Records how automated and human evidence will be obtained for the chosen pillars. |
| Targets | Optional score and date commitments, one selected pillar at a time. Targets do not alter scoring. |

Definitions are versioned. Revising a definition does not rewrite earlier runs; each run keeps the definition fingerprint and methodology revision it used.

## Run-time scope

The **Run assessment** dialog lets an assessor:

- run the complete saved definition;
- run one pillar or any subset from it; or
- choose a custom workspace scope for a one-off run without revising the saved definition.

The confirmation line states the pillar count, workspace source and lookback window before the run starts.

## Scheduled assessments

Scheduling is optional. The deployed Lakeflow Job begins paused and uses a dedicated service principal.

### Create the identity and secret

```bash
databricks service-principals create --display-name "Well-Architected schedule" --profile <profile>
databricks service-principal-secrets create <numeric-principal-id> --profile <profile>
databricks secrets create-scope waf-schedule --profile <profile>
databricks secrets put-secret waf-schedule oauth-secret --string-value "<secret>" --profile <profile>
```

Store only the application id, scope name and key name in the DAB override. The secret value remains in the Databricks secret scope and is read by the job, not by the App.

### Preview derived grants

The repository derives required grants from the statements the assessment runs. Start with validation. To include metadata visibility across customer catalogs and sharing configuration, preview:

```bash
npm run lifecycle -- upgrade --profile <profile> --target customer \
  --schedule-catalogs all --schedule-sharing
```

Apply only after reviewing the exact report:

```bash
npm run lifecycle -- upgrade --profile <profile> --target customer \
  --schedule-catalogs all --schedule-sharing --apply
```

The principal needs App access, `CAN_USE` on the warehouse, `USE CATALOG` and `USE SCHEMA` plus `SELECT` on the required system schemas, and direct membership in the configured assessor group. Extra catalog and sharing grants are optional coverage decisions.

### Bind the saved assessment

Copy the definition id from **Method → Definitions** into `schedule_assessment_id`, upgrade through the lifecycle wrapper, and run the job manually once. Only unpause it after the readiness and assessment tasks both succeed.

## Local development

Copy `app/.env.example` to the ignored `app/.env` only when local development needs live Databricks data. The supported values are:

| Variable | Purpose |
| --- | --- |
| `DATABRICKS_HOST` | Workspace host for local on-behalf-of development. |
| `DATABRICKS_WAREHOUSE_ID` | Development warehouse. |
| `DATABRICKS_APP_PORT` | Local port, normally `8000`. |
| `DATABRICKS_APP_NAME` | Local App name. |
| `FLASK_RUN_HOST` | Bind host used by the development runtime. |

Never commit `.env`, tokens, DAB overrides or Lakebase backups.

## Next

[Run the complete customer journey →]({{ '/user-guide/' | relative_url }})
