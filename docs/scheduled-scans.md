---
title: Detailed scheduled-assessment setup
description: Configure the dedicated identity, grants, job and operating model for scheduled assessments.
permalink: /scheduled-scans/
eyebrow: Operator runbook
---

# Running the assessment on a schedule

The app works without this. Everything here is optional, and the reason to want it is narrow: a
trend line is only worth reading if the runs behind it are evenly spaced, and runs somebody
remembered to start are not. Four scans across a quarter, taken on the days an admin happened to
open the app, cannot tell you whether a score moved because the estate changed or because a
different week was sampled.

Setting this up is a handful of grants and one secret, and there is a tool that reports and makes the
grants for you. The job is deployed **paused**, so nothing runs until the last step.

## What runs, and as whom

A weekly Databricks job calls `POST /api/scan/scheduled` on the app. That is the whole of it — there
is no second copy of the assessment engine, and the app treats the call the same way it treats an
admin pressing the button.

The job authenticates as a service principal you choose. The Apps proxy takes that identity, checks
it may use the app, and mints it an on-behalf-of token holding only the scopes the app declares. The
app then reads the estate with that token. So **what a scheduled run can see is decided entirely by
the grants on the service principal you nominate**, and it can never exceed what a person holding
the same grants would see. The app gains no authority of its own and holds no secret of its own.
The declared scopes never include the blanket `all-apis` scope.

The consequence worth reading twice: **a service principal you have just created can read nothing.**
It has no warehouse it may use and no `SELECT` on the system schemas, so its first scheduled run
would find 184 requirements and measure two of them. That is why the grants below are not optional
setup detail, and why the job fails on purpose when they are missing rather than recording a
flattering assessment of an estate it could not see.

## Setting it up

### 1. A service principal for the schedule

Use a dedicated one rather than an existing admin principal. The point of the separation is that you
can read, in one place, exactly how much of the estate the unattended run is allowed to see:

```bash
databricks service-principals create --display-name "Well-Architected schedule"
```

Note the `applicationId` it returns. That is the `client_id` below — not the numeric `id`.

### 2. Its OAuth secret, in your own secret scope

The proxy accepts an OAuth token and nothing else. A job's own ambient credentials, the same token
via `dbutils`, and a personal access token minted inside the run were each measured against a live
install and refused with a bare `401`; token exchange needs a federation policy that does not exist
by default. So the job performs a client-credentials grant, and that needs a secret.

The secret is yours. It lives in your secret scope, the job reads it, and the app is never given it
— `app.yaml` binds no secret resource, so nothing hands the app's own identity a way to read it.

```bash
databricks service-principal-secrets create <numeric-id-of-the-principal>

databricks secrets create-scope waf-schedule
databricks secrets put-secret waf-schedule oauth-secret --string-value "<the secret>"
```

The value is read through `dbutils.secrets.get`, which redacts it from task output. It is never
printed, never included in an error message, and never sent anywhere but your workspace's own token
endpoint.

### 3. The grants, and one group

There is a tool for this, and it is the authority rather than the list below. It reads every statement
the assessment runs, works out which schemas they read, and reports what your principal holds against
what it needs:

```bash
DATABRICKS_CONFIG_PROFILE=<profile> npm run schedule:principal -- --client-id <application-id>
```

It changes nothing. Add `--apply` and it grants the difference; run it twice and the second run finds
everything held and issues nothing. It exits non-zero while anything is missing, so it can go in front
of an unpause.

Why a tool rather than the list this section used to be: the list was wrong. It named five system
schemas and the app reads seven, so every scheduled run had been failing to read `system.storage` —
`INSUFFICIENT_PERMISSIONS: User does not have USE SCHEMA on Schema 'system.storage'` — and two
requirements, CO-03-06 and PE-03-15, reported themselves unmeasured every week for a reason nobody
could see. That is the failure mode this whole page is about, so the grant list is now derived from
the statements instead of written down.

What follows is what the tool asks for and why, because you should be able to read it before running
it.

Before any grant: **the principal has to be a member of the group named in `WAF_ASSESSOR_GROUP`**,
which is the group whose members may change an assessment, and starting one is a change. Add it
directly rather than through a nested group — SCIM reports direct memberships only, so a principal
in a group that is itself inside the assessor group is refused. Without this the job's POST comes
back `403 not-a-member`, which is the gate working; the message names the group to add it to. This
is the one respect in which a scheduled run needs more than the estate grants below, and it exists
because "nobody was watching" is not a reason to skip authorization.

**`CAN_USE` on the app.** Without it the proxy refuses before the app is reached, and the failure
arrives as an empty `401` — the job recognises that shape and says so in as many words, because a
bare `401` with no body has sent people to check the wrong thing more than once.

```bash
databricks apps set-permissions databricks-waf-assessment --json '{
  "access_control_list": [
    { "service_principal_name": "<application-id>", "permission_level": "CAN_USE" }
  ]
}'
```

**`CAN_USE` on a SQL warehouse.** Every system-table reading goes through one. Without it the app
records, against each affected requirement, that the warehouse refused with a 403 — which is the
honest answer, and a useless assessment.

**`SELECT` on the system schemas the app reads**, plus the two grants that make `SELECT` usable.
`SELECT` on its own is not enough, which is worth stating plainly because it costs an hour to
discover: Unity Catalog also needs `USE CATALOG` on `system` and `USE SCHEMA` on each schema, and
without them every query fails with `INSUFFICIENT_PERMISSIONS: User does not have USE SCHEMA`. The
first version of this guide listed only `SELECT`, and the run that followed it measured four
requirements out of 184.

Which schemas is what the tool derives, and the reason this page no longer says. Print them without
touching anything:

```bash
DATABRICKS_CONFIG_PROFILE=<profile> npm run schedule:principal -- --client-id <application-id>
```

Grant only what you want an unattended run to be able to see; the app names each schema it could
not read rather than quietly scoring around the gap. One schema the tool deliberately does *not* ask
for is `system.information_schema`, and it says so when it runs: the grant is accepted and changes
nothing, because those views are filtered by what the reader may see rather than by a grant on the
schema. Widening them means granting on the catalogs, which is the next section.

**Nothing on the store.** Worth stating because the obvious guess is wrong and this guide guessed it
for a while: the scan is written to Lakebase by the app's own service principal, not by the identity
that asked for it, so a scheduled principal needs no grant on the database. The same goes for reading
attestations — a scheduled run sees every answer, because the store is the app's own bookkeeping
rather than the customer's data. What the schedule's identity governs is what the *estate* looks
like, which is the grants above. Nothing about a schedule changes who may answer a question.

### Optionally, how much of your estate the run can see

The grants above are enough for the assessment to run. They are not enough for it to see your
tables, and that is a decision rather than an oversight.

`system.information_schema` reports only the objects its reader holds a privilege on. A principal
with the system-schema grants and nothing on your catalogs reads a full metastore as an empty one —
so the requirements that count tables do not report a small number, they report none. In a controlled
calibration run, the same census statement returned 21 tables to an admin and 0 to that principal,
in the same minute, against the same estate.

Three options, and the middle one did not exist until it was measured:

| | What it grants | What a scheduled run answered | What it can read |
| --- | --- | --- | --- |
| Nothing | the grants above only | **25** of 184 requirements | no catalog of yours |
| `BROWSE` | `BROWSE` on each customer catalog | **43** | the names, owners, formats and descriptions of your tables |
| `SELECT` | `USE CATALOG`, `USE SCHEMA` and `SELECT` | **49** | the rows |

`BROWSE` is a catalog-level metadata privilege. It needs no `USE CATALOG` and no `USE SCHEMA`, and
it grants access to no row in any table — the reader can see that a table exists and what shape it
is, and cannot read it. That recovers 18 of the 24-requirement difference.

The six it does not recover are the table-layout ones — clustering, file sizes, predictive
optimization — which are read with `DESCRIBE DETAIL`, and `DESCRIBE DETAIL` needs `SELECT`. That was
established by running it rather than inferred from the privilege reference: under `BROWSE` alone it
fails with `User does not have USE CATALOG`, and with `USE CATALOG` and `USE SCHEMA` added it fails
with `User does not have SELECT`. There is no metadata-only grant that reaches it.

The tool derives which catalogs those are the same way the assessment does — everything the metastore
holds that Databricks does not own — and grants nothing unless asked:

```bash
DATABRICKS_CONFIG_PROFILE=<profile> npm run schedule:principal -- --catalogs all
DATABRICKS_CONFIG_PROFILE=<profile> npm run schedule:principal -- --catalogs all --apply
```

The first prints the statements; the second issues them. `--catalogs main,analytics` takes a subset.
Without the flag the report says how many customer catalogs it found and that it did not ask for
them, so you can decline this on purpose rather than by not knowing about it.

If you would rather an unattended identity saw nothing of your estate, that is a defensible answer
and the app will not pretend otherwise — but it now says so differently. A requirement it cannot see
the estate for reports as unmeasured with the grant that would fix it, where it used to report that
your metastore contained no tables. That sentence was wrong on every scheduled run that produced it.

### Optionally, whether the run can count what you share

`BROWSE` does not cover this one, which is why it is a second decision and a second flag. Shares,
recipients, providers and Lakehouse Federation connections are each filtered by their own
metastore-level grant, and a principal holding `BROWSE` on every catalog you have still counts all
four as zero. In a controlled calibration run, with `BROWSE` in place the scheduled principal read
0 providers of 1 and 0 connections of 1.

| Grant | What it makes countable |
| --- | --- |
| `USE SHARE` | the shares this metastore publishes |
| `USE RECIPIENT` | the recipients it publishes them to |
| `USE PROVIDER` | the providers it receives shared data from |
| `USE CONNECTION` | the Lakehouse Federation connections |

```bash
DATABRICKS_CONFIG_PROFILE=<profile> npm run schedule:principal -- --sharing
DATABRICKS_CONFIG_PROFILE=<profile> npm run schedule:principal -- --sharing --apply
```

All four are on the metastore rather than on named objects, and that is the platform's shape rather
than the tool's convenience: `GRANT USE PROVIDER ON PROVIDER` is refused outright, and
`GRANT ... ON SHARE <name>` to a principal does not parse. Only connections can be granted one at a
time, and a count is a claim about all of them, so the tool does not offer it.

What they let the identity do was measured rather than read off the privilege reference. Holding all
four, the principal's `CREATE FOREIGN CATALOG` against a connection it could now see was refused with
*"User does not have CREATE CATALOG on Metastore"*. That is the one creation the measurement tried,
and it is the one worth knowing: these grants make the sharing configuration countable without making
the connection usable. What they do add beyond a count is metadata — `USE CONNECTION` exposes each
connection's `url`, which for a federated connection is the source system's hostname.

Decline it and nothing is scored wrongly: the two requirements that read this part of the metastore
report themselves unreadable and name the grant, in the same way as the catalogs above. What they
must never do again is what they did before this was measured — tell a reader an estate receives no
shared data while an inbound provider sits in it, invisible to the identity that looked.

### 4. Point the bundle at all of it, then unpause

In your target's `variables` block in `app/databricks.yml`:

```yaml
app_url: https://<your-app>.aws.databricksapps.com
schedule_client_id: '<application-id>'
schedule_secret_scope: waf-schedule
schedule_secret_key: oauth-secret
```

`app_url` is the app's own hostname, reported as `url` by `databricks apps get` — not the workspace
URL. Posting to the workspace instead would authenticate successfully and then reach nothing, so the
job checks for that mistake by name before it does anything else.

### Optionally, which assessment the scheduled runs answer to

A scheduled run answers to no assessment definition unless you name one:

```yaml
schedule_assessment_id: '<assessment-id>'
```

The ids are on the app's assessments page. Naming one has every run of this job recorded against that
assessment, so the weekly results join one history instead of standing alone — and it is an id rather
than a rule on purpose. A job that asked for "the newest assessment" when it fired would answer to a
different one the moment somebody defined one, and the trend would step for a reason nothing recorded.
Changing which assessment the job answers to is therefore editing this variable and deploying.

The assessment carries its own window, so `lookback_days` on the job stops applying when you name one:
the definition says which pillars, which workspaces and how far back, and the app refuses a request
that sets both rather than silently preferring one.

Leaving it empty is a supported setting and the default. The app's Runs page says which of the two your
deployed job is set to, including the two ways it can be wrong — an id this install no longer keeps, and
an assessment somebody has archived. The scan route refuses a run naming either, so those are worth
seeing on the page rather than at 06:00 on a Monday.

There is one more variable you probably do not want. `job_performance_target` is `STANDARD`, which
costs a serverless start of two to four minutes and about a third of the DBUs of the alternative. At
06:00 on a Monday that start is free in every sense that matters, and the job's own patience is
measured from when its notebook begins rather than from when you asked. Set it to
`PERFORMANCE_OPTIMIZED` only if you are triggering the job by hand repeatedly and waiting for each
one — a development workspace, not a customer's. A controlled calibration measured 123 seconds
against 205 seconds for the same job on the same day.

Deploy, then run it once by hand before trusting the schedule:

```bash
databricks bundle deploy
databricks jobs run-now <job-id>
```

Read the task output. A healthy run prints how many of the 184 requirements it measured. If the
grants are short, the task **fails**, and the message names what could not be read and which
identity could not read it. Fix the grants and run it again — this is much better discovered now
than three weeks into a flat trend line.

A `403 not-a-member` in the task output means the group from step 3 is missing rather than a grant:
the principal reached the app and was refused permission to start anything. `403 membership-unknown`
means something different and worth reporting — the app could not read the principal's group
memberships at all, so it refused rather than assuming.

When a by-hand run comes back healthy, unpause the schedule in the job UI, or set
`pause_status: 'UNPAUSED'` in `app/resources/scheduled-scan.yml` and redeploy. It runs at 06:00 UTC
on Mondays. Weekly rather than daily because the usage and audit data the app scores arrive with a
lag of their own: a daily run would mostly re-read the same rows for a warehouse bill.

## What the job does when something goes wrong

The job supervises the run; the app performs the assessment. The reason is plain: a Lakeflow task
runs Python, SQL, dbt or a JAR, the assessment engine is
TypeScript, and a second implementation of 184 requirements in a second language would reach you as an
estate change that never happened.

What supervision means in practice is that **an interrupted assessment is resumed rather than lost or
repeated.** Each attempt posts the same idempotency key — built from the job run — so the app carries
on the run that key names from its last checkpoint:

| What happened | What you see |
| --- | --- |
| The app was replaced mid-scan, or the connection dropped | The task waits, then posts the same key again and the app resumes from its last checkpoint |
| The task ran out of time while the app was still collecting | The retry rejoins the same run rather than starting a new one |
| The reply was lost after the app had finished | The retry is told the run is already finished, and reports what it found |
| Another process holds the run | The task waits for it rather than failing |
| A grant is missing | The readiness task fails once and names the grant, and the assessment never starts. Not everything is worth retrying |

Retries are the task's own: three, two minutes apart. That is enough for an app being replaced and
deliberately not enough to paper over a missing grant, which fails identically every time and should
reach you on Monday rather than after lunch.

**The refusals no retry can clear are found before the retrying starts.** The job has two tasks. The
first asks the app one question — may this identity start a scan, and is there a warehouse to read the
estate with — and carries no retries, because its answer will not change by being asked again. The
second is the assessment, and it runs only if the first said yes.

That split is about cost rather than tidiness. Measured on this workspace before it existed: a service
principal outside the assessors group cost four attempts, seven and a half minutes of serverless
startup and 47 seconds of work, to learn the same thing four times. The readiness task learns it once,
in about 15 seconds, and the assessment is skipped rather than attempted. On the way through, the
second task reuses the compute the first one warmed — measured at one second of startup against the
four to six minutes a cold standard-mode start takes — so asking first costs a healthy Monday almost
nothing.

What it does not do is turn a restarting app into a missed week, because **it acts on answers only.**
An app that is not answering yet is waited for, for up to five minutes; an app still not answering
after that is handed to the assessment, whose own retries wait far longer than this task can. An app
too old to serve the question says so and the assessment is attempted anyway, which is what it did
before this task existed. So the only thing that stops the assessment here is the app saying it would
refuse one.

**Cancelling the job run cancels the assessment.** The task passes the cancellation on to the app,
which ends the run with what it had reached and records it as cancelled. Best-effort: a cancelled task
is given a moment rather than a guarantee, and where the request does not get out, the run's claim
lapses and the next trigger takes it over.

**Repairing a run starts a new one.** A retry is the machine saying "carry on"; a repair is a person
saying "I have fixed something, go again" — usually a grant. Resuming would skip every signal the
broken run already read, including the refusals your fix was meant to clear, so a repair assesses the
estate again from the beginning. Expect two runs for one Monday in that case; they measured different
estates, and the trend shows the second.

Who the job runs as is a separate question from who the assessment runs as, and only the second one
governs what can be read. The task runs as whoever deployed the bundle — that identity reads the
secret and owns the run history — and the assessment runs as the service principal from step 1,
through the token the proxy mints for it. `run_as` is left unset deliberately: the schedule is
optional, and a bundle that named an empty service principal would refuse to deploy for every install
without one.

## When a run comes back blind

Nobody is watching a scheduled run, so the app has to notice on their behalf. An assessment that
could not read the estate does not look broken — it looks like a flat trend line, and the reader has
no way to tell the difference weeks later.

So a scheduled run is refused when **more requirements failed to read than were measured**. The
comparison has no constant in it deliberately. The obvious rule — refuse when nothing scored — was
written first and defeated immediately: a service principal with no grants at all still returned one
pass and one partial, from the two requirements answerable without reading anything, and the job
reported success.

Only genuine read failures count. The 37 requirements no install can reach, the questions that need
a person, and the checks this app has not built are all excluded; counting those would fail every
run including a perfect one.

The refused scan is still saved. The message asserts what could not be read, and an assertion the
reader cannot check is worth less than one they can — so the task fails, and the evidence sits at
`/api/scans/<id>` and in the app's history, marked as having run on a schedule.

## Turning it off

Pause the job, or delete `app/resources/scheduled-scan.yml` and redeploy. Nothing else references
it: `databricks.yml` includes the directory rather than the file, the app never learns whether the
job exists, and `/api/scan/scheduled` is simply a route nobody calls.

The grants come off with the same tool that put them on, which reports before it removes:

```bash
DATABRICKS_CONFIG_PROFILE=<profile> npm run schedule:principal -- --revoke
DATABRICKS_CONFIG_PROFILE=<profile> npm run schedule:principal -- --revoke --apply
```

It revokes the set it derives — `system`, each system schema, `BROWSE` on each customer catalog and
the four sharing grants on the metastore — from the principal you name, and removes that principal
from the assessor group. Two things it says when it runs, and they are worth knowing first. It
cannot tell a grant it issued from an
identical one somebody made by hand, so it removes either. And it leaves the two object permissions
alone: the permissions API replaces an access list rather than editing it, so dropping the
principal's `CAN_USE` on the app or the warehouse would mean writing back everyone else's entries,
which a tool asked to remove one principal's access has no business doing. Remove those two in the
UI.

Delete the secret scope if the principal was created only for this.
