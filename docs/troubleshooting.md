---
title: Troubleshooting
description: Diagnose installation, permission, collection, review, schedule and data-store failures.
permalink: /troubleshooting/
eyebrow: Use the app
---

# Troubleshooting

Start with **Utilities → Diagnostics**. It distinguishes a warehouse reading, durable database, audit trail and current identity and links to the page that owns the next action.

## The App does not start or returns 502

1. Read the deployed App and active deployment:

   ```bash
   databricks apps get databricks-waf-assessment --profile <profile> -o json
   databricks apps logs databricks-waf-assessment --profile <profile>
   ```

2. Confirm the active deployment succeeded and the App state is `RUNNING`.
3. Re-run lifecycle validation and compare the resolved warehouse and Lakebase resources with the deployed bindings.
4. Confirm the Lakebase branch and database still exist and the App retains `CAN_CONNECT_AND_CREATE`.
5. Use `upgrade` through the lifecycle wrapper if the deployed source, configuration or bindings drifted.

Do not patch the App configuration by hand; the next DAB deployment would replace that untracked change.

## “The plans could not be read” or another page-level 502

Open Diagnostics first. If Database is not answering, fix the Lakebase binding or deployment before retrying the page. If only one record family fails, capture the request time, selected assessment and page, then check App logs for the matching error. Include those details in a bug report, but remove customer data and credentials.

## A collector returned nothing or was refused

Open **Method → Checks**. Filter to the affected pillar or status. Checks names the statement, source and required grant and links back to the run record.

An empty source can be a fact about the selected window rather than the whole estate. Increase the lookback only when that matches the assessment question; do not widen a window solely to make the warning disappear.

## The score looks strong but coverage is low

Read coverage and confidence before posture. Unmeasured requirements are excluded, so a score describes only evaluated applicable requirements. Pillars with insufficient evidence are shown as not assessed. Use the Dashboard's coverage follow-ups to answer human-only requirements or restore unreadable evidence.

## The answer button is disabled

The guided answer requires a complete outcome record. Select an outcome and provide the required supporting evidence or rationale, accountable owner and next review date. The button enables when all required fields are valid.

## A user can read but cannot start or change anything

Mutations require direct membership in `assessor_group`. Nested group membership is not accepted because the identity API reports direct memberships for this gate. Add the user directly to the configured group or change the DAB variable through a reviewed upgrade.

## The wrong workspace appears in validation

Run:

```bash
databricks current-user me --profile <profile>
```

Then unset any `DATABRICKS_HOST`, `DATABRICKS_TOKEN`, `DATABRICKS_CLIENT_ID`, `DATABRICKS_CLIENT_SECRET`, `DATABRICKS_CONFIG_PROFILE` or account selector in the shell. The lifecycle wrapper removes these for its child commands, but standalone CLI commands do not.

## The scheduled job fails readiness

Read the readiness task output. Verify:

- the application id, secret scope and secret key names in the DAB override;
- the secret contains the current OAuth secret;
- the service principal can use the App and warehouse;
- direct membership in the assessor group; and
- required Unity Catalog `USE` and `SELECT` grants.

Preview the derived grant report again. Do not replace the principal with an administrator identity simply to make the run green.

## A scheduled assessment is not visible where expected

Check `schedule_assessment_id`. When set, the job uses that exact definition and its scope. When empty, it creates an ad-hoc scheduled run. Confirm that the selected assessment in the App matches the definition the schedule uses.

## Improvement work says it is contradicted

The action was recorded as done, but a later comparable assessment still found one of its requirements unmet. Open the action, follow its requirement link and compare the newer evidence. Correct the action record or raise the remaining work; do not edit the finding.

## Report movement is unavailable

Two runs are compared only when their assessment scope and methodology are comparable. A changed pillar set, workspace scope, lookback semantics or scoring methodology may make “no comparison” the honest result.

## Before raising an issue

Collect:

- exact commit or release;
- installation or upgrade command without secrets;
- selected page and assessment scope;
- expected and observed result;
- App state and active deployment state;
- relevant redacted logs; and
- current Chrome version for visual or interaction faults.

[Raise the right kind of issue →]({{ '/contributing/#raise-an-issue' | relative_url }})
