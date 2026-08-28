# Databricks notebook source
# Supervise an assessment: start it, follow it, carry on the one it already started, stop it when
# this task is stopped, and fail the task if what came back was not worth keeping.
#
# This is the whole of the scheduled path: there is no second copy of the assessment engine here.
# The job authenticates as a service principal, the Apps proxy mints that identity an
# on-behalf-of token scoped to exactly what the app declares, and the app reads the estate with
# it. So a scheduled run sees what an interactive run by the same identity would see and no more,
# and the app never gains an authority of its own. ADR 0021 has the measurements.
#
# The division of labour is ADR 0060's: the job triggers, supervises, retries and cancels, and the
# app executes. A Lakeflow task runs Python, SQL, dbt, a JAR or another job, and the engine is
# TypeScript — so putting the assessment in here would mean a second implementation of 184
# requirements in a second language, and any divergence between the two would reach a customer as an
# estate change that never happened.
#
# What makes that division safe is the run record. A retry does not start a second assessment of the
# same night: it posts the same idempotency key, and the app carries on the run that key names from
# its last checkpoint. That is why this file can be interrupted, time out, or lose the app mid-scan
# without losing the work.
#
# Why a service principal secret rather than the job's own ambient credentials: measured against a
# live install, the Apps proxy accepts an OAuth token and nothing else. A job's runtime token, the
# same token via dbutils, and a personal access token minted on the spot were each refused with a
# bare 401, and token exchange needs a federation policy that does not exist by default. So an
# OAuth client-credentials grant is not a preference here, it is the only door.
#
# The secret is the customer's, in the customer's secret scope, read by this job. The app does not
# read it, is not given it, and its manifest does not request one.
#
# Before scheduling this, two things have to be true or the task will fail on purpose:
#
#   * The service principal has CAN_USE on the app, or the proxy refuses before the app is reached.
#   * The service principal has its own grants on the estate — a warehouse it may use, and USE
#     CATALOG, USE SCHEMA and SELECT on the system schemas. SELECT alone is not enough and fails
#     with INSUFFICIENT_PERMISSIONS. A newly created principal can read nothing at all, and this
#     task then fails rather than recording a flattering assessment of an estate it could not see.
#
# `docs/scheduled-scans.md` is the setup, in order.

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

dbutils.widgets.text("app_url", "", "App URL, e.g. https://my-app.aws.databricksapps.com")
dbutils.widgets.text("workspace_url", "", "Workspace URL, where the OAuth token is minted")
dbutils.widgets.text("client_id", "", "Application id of the service principal to run as")
dbutils.widgets.text("secret_scope", "", "Secret scope holding that principal's OAuth secret")
dbutils.widgets.text("secret_key", "", "Key within that scope")
dbutils.widgets.text("lookback_days", "30", "Days of usage and audit history to read")
dbutils.widgets.text("assessment_id", "", "The assessment every run answers to, by id; empty for none")
dbutils.widgets.text("job_id", "", "This job, part of the key that makes a retry one run")
dbutils.widgets.text("job_run_id", "", "This run of it, the part that changes every schedule tick")
dbutils.widgets.text("repair_count", "0", "How many times a person has repaired this run")
dbutils.widgets.text("phase", "assess", "readiness to ask whether a scan would run, assess to run one")


class TaskFailed(Exception):
    """How this notebook fails, and it is deliberately not `SystemExit`.

    Measured on labs, twice. `raise SystemExit` reads well — the run page shows the message and
    nothing else — but it exits the interpreter, so the platform records the run as INTERNAL_ERROR
    rather than as a task that failed, and it retries an internal error whatever the retry policy
    says. A readiness task carrying `max_retries: 0` ran twice on a permission refusal that could not
    change, which is the cost this phase exists to avoid, arriving through the way it was raised.

    An ordinary exception fails the task as a task. The message still reaches `get-run-output` as the
    `error`, which is the only part anyone reads.
    """


def required(name: str) -> str:
    value = dbutils.widgets.get(name).strip()
    if not value:
        raise TaskFailed(
            f"The {name} parameter is empty. All of app_url, workspace_url, client_id, secret_scope "
            "and secret_key are needed; docs/scheduled-scans.md lists where each comes from."
        )
    return value


app_url = required("app_url").rstrip("/")
workspace_url = required("workspace_url").rstrip("/")
client_id = required("client_id")
lookback_days = int(dbutils.widgets.get("lookback_days") or "30")

# The assessment this run answers to, carried rather than chosen.
#
# An id in the job definition is what makes the target immutable: a job that asked the app for "the
# newest assessment" when it fired would answer to a different one the moment somebody defined one,
# and the trend it feeds would step for a reason nothing recorded. GAP-036.
#
# Empty is a supported setting and the default. The run then answers to no assessment, which is what
# every run of this job did before this parameter existed, and the app records it exactly that way
# rather than picking one.
#
# An unsubstituted variable is dropped rather than sent. `${var.schedule_assessment_id}` is what this
# reads on a job that never went through a bundle deploy, and posting it would have the app refuse the
# run for naming an assessment whose id is a template — a failure about the wrong thing.
assessment_id = dbutils.widgets.get("assessment_id").strip()
if assessment_id.startswith("${"):
    print(
        f"assessment_id is {assessment_id!r}, an unsubstituted bundle variable rather than an id. "
        "Assessing without naming an assessment; set schedule_assessment_id and deploy to name one.",
        file=sys.stderr,
    )
    assessment_id = ""

# Read through dbutils so the value is redacted from task output. Never printed, never put in an
# error message, and never sent anywhere except the workspace's own token endpoint below.
client_secret = dbutils.secrets.get(scope=required("secret_scope"), key=required("secret_key"))

if app_url == workspace_url:
    raise TaskFailed(
        "app_url and workspace_url are the same. An app is served from its own hostname — "
        "`databricks apps get <name>` reports it as `url` — and posting the scan request to the "
        "workspace instead would authenticate and then reach nothing."
    )

# The key that decides what a repeat of this task means, and the only reason a retry is safe.
#
# It names the job run, so every automatic retry of this task posts the same key and the app carries
# on the run it already has from its last checkpoint. The next schedule tick is a different job run,
# so it is a different key and a new assessment — which is what a weekly trend is made of.
#
# The repair count is in it because a person repairing a run means something an automatic retry does
# not. A retry is the machine saying "the connection broke, carry on"; a repair is a person saying
# "I have fixed what was wrong, go again" — most often a grant. Carrying on would skip every signal
# the broken run already read, including the refusals their fix was meant to clear, and report an
# estate that no longer exists. So the machine resumes and the person starts over.
#
# `{{job.id}}`, `{{job.run_id}}` and `{{job.repair_count}}` are substituted by Lakeflow before this
# notebook starts. Absent — someone running this by hand — the key is dropped rather than guessed,
# and the app treats an unkeyed trigger as one intention, which by hand it is.
job_id = dbutils.widgets.get("job_id").strip()
job_run_id = dbutils.widgets.get("job_run_id").strip()
repair_count = dbutils.widgets.get("repair_count").strip() or "0"
key = f"job-{job_id}/run-{job_run_id}/repair-{repair_count}" if job_id and job_run_id else None

# How long to keep following a run this task did not manage to see the end of, and how long to leave
# between looks. The task's own `timeout_seconds` is the real bound; this one exists so that a task
# about to be killed spends its last minutes saying what it was waiting for.
WAIT_SECONDS = 30
GIVE_UP_AFTER_SECONDS = 3000

# How long the readiness phase waits for an app that is not answering, and it is deliberately much
# shorter than the supervisor's.
#
# The first version reused `GIVE_UP_AFTER_SECONDS`, on the reasoning that a restarting app is
# transient for both phases and both should wait it out. That was right about the app and wrong about
# the arithmetic: the readiness task's `timeout_seconds` is 900, so the platform kills the task at
# fifteen minutes and the 50-minute wait never elapses. A restart of twenty minutes would have failed
# readiness on a timeout, skipped the assessment, and missed the week — the exact outcome this phase
# was added to prevent, arriving through the phase that prevents it.
#
# So the budget fits inside the timeout with room for a serverless start, and running out of it does
# not fail. See `check_readiness`: an app that never answers is not an answer, and the supervisor is
# the half of the job built to wait — three retries, two minutes apart, on the longer clock.
# `check:supervision` holds these two numbers against the task's timeout.
READINESS_WAIT_UP_TO_SECONDS = 300


def fail(message: str) -> None:
    """Fail with the reason in the message, because that is the only part anyone reads.

    Measured against a live run rather than assumed: what `jobs get-run-output` returns as `error`,
    and what the run page shows, is this message. An earlier version printed the diagnosis to stderr
    and exited with "failed with HTTP 422"; the diagnosis went to a driver log nobody opens, and the
    failure an operator saw named a status code and no cause. For a job whose entire reason to exist
    is telling somebody who was not watching what went wrong, that is the same as failing silently.

    The status code belongs in the caller's message, once. This function adding it too produced
    "HTTP 422. The assessment did not complete. HTTP 422:" on a live run.

    Why not `SystemExit`, which this used to raise: see `TaskFailed`. It cost a second attempt at
    every settled failure.
    """
    print(message, file=sys.stderr)
    raise TaskFailed(message)


# An OAuth token for the service principal. `all-apis` is what a client-credentials grant is given
# here; it is not what the app will act with. The proxy overrides it with an on-behalf-of token
# holding only the app's declared scopes, which was measured rather than assumed — see ADR 0021.
token_request = urllib.request.Request(
    f"{workspace_url}/oidc/v1/token",
    data=urllib.parse.urlencode({"grant_type": "client_credentials", "scope": "all-apis"}).encode(),
    headers={"Content-Type": "application/x-www-form-urlencoded"},
    method="POST",
)
token_request.add_unredirected_header(
    "Authorization",
    "Basic " + __import__("base64").b64encode(f"{client_id}:{client_secret}".encode()).decode(),
)

try:
    with urllib.request.urlopen(token_request) as response:
        access_token = json.load(response)["access_token"]
except urllib.error.HTTPError as error:
    # The body here can name the problem precisely — an unknown client, an expired secret — and it
    # never contains the secret itself.
    fail(
        "Could not obtain an OAuth token for the service principal. The workspace returned "
        f"HTTP {error.code}: {error.read().decode(errors='replace')[:500]}\n\n"
        "Check that client_id is the application id of the principal, and that the secret in "
        f"{dbutils.widgets.get('secret_scope')}/{dbutils.widgets.get('secret_key')} is current."
    )

AUTHORIZATION = {"Authorization": f"Bearer {access_token}"}


def call(path: str, body: dict | None = None, headers: dict | None = None):
    """One request to the app, with the reply parsed and an HTTPError left for the caller to read.

    No client-side timeout on purpose. An assessment takes as long as the estate takes, its own
    per-surface budgets bound that, and abandoning the request while the app is still writing its
    result would leave this task failed and the assessment recorded — the one outcome that makes the
    job's history lie about the app's. When the app goes away rather than being slow, the connection
    breaks and that is a different exception, handled where it matters.
    """
    request = urllib.request.Request(
        f"{app_url}{path}",
        data=None if body is None else json.dumps(body).encode(),
        headers={**AUTHORIZATION, "Content-Type": "application/json", **(headers or {})},
        method="GET" if body is None else "POST",
    )
    with urllib.request.urlopen(request) as response:
        return json.load(response)


def problem(error: urllib.error.HTTPError) -> tuple[dict, str]:
    """An error body as both the object the app sent and the sentence a person should read."""
    body = error.read().decode(errors="replace")
    try:
        sent = json.loads(body)
    except json.JSONDecodeError:
        return {}, body

    if not isinstance(sent, dict):
        return {}, body

    # An empty body on a 401 is the proxy rather than the app, and means the principal has no
    # CAN_USE on the app. Worth separating, because the fix is in a different place from the
    # app's own refusals — and because a bare "401 {}" has sent people to check the wrong thing.
    return sent, str(sent.get("message", body))


def proxy_refusal(error: urllib.error.HTTPError, body: str) -> None:
    if error.code == 401 and body.strip() in ("", "{}"):
        fail(
            "The Databricks Apps proxy rejected the request before the app saw it. Grant this "
            f"service principal ({client_id}) CAN_USE on the app."
        )


# What asking the app about our own run can come to. They are separate because the answer to each is
# different, and because collapsing them is how "we could not ask" reads as "there is nothing to
# ask": the same silence that means the app is still restarting would send an operator to bind a
# database that has been bound all along.
UNREACHABLE = "unreachable"
NO_STORE = "no-store"
UNKEYED = "unkeyed"
NO_RUN = "no-run"
FOUND = "found"


def our_run() -> tuple[str, dict | None]:
    """The run this task's key names, or which of the reasons there is not one to name."""
    if key is None:
        return UNKEYED, None
    try:
        answer = call("/api/runs?" + urllib.parse.urlencode({"key": key}))
    except (urllib.error.URLError, OSError):
        return UNREACHABLE, None
    if not answer.get("durable"):
        return NO_STORE, None
    runs = answer.get("runs") or []
    return (FOUND, runs[0]) if runs else (NO_RUN, None)


def report(summary: dict, why_blind: str | None = None) -> None:
    """Say what the run found, and fail the task where what it found is not an assessment.

    The blindness verdict is the app's, read from the summary rather than worked out here from the
    numbers beside it. A rule re-derived in this file would be a second copy of a judgement the app
    already makes, and the copies would agree right up until one of them changed.

    `why_blind` is the app's own account of which grants were missing, which it sends with the refusal
    and cannot be reconstructed from a summary. Absent when this task is reading a summary rather than
    being refused — where a retry's reply went missing, say — so there is a sentence of last resort
    that says the same thing with numbers instead of grants.
    """
    print(json.dumps(summary, indent=2))
    if summary.get("blind"):
        fail(
            why_blind
            or (
                "The assessment read less of the estate than it failed to read: "
                f"{summary['measured']} of {summary['requirements']} requirements measured. Recorded "
                f"as scan {summary['scan']}, and reported as a failure so that a flat trend line is "
                "not mistaken for good news. `npm run schedule:principal` names the grants this "
                "identity is missing."
            )
        )
    print(
        f"\nMeasured {summary['measured']} of {summary['requirements']} requirements "
        f"as {summary['ranAs']}. Recorded as scan {summary['scan']}."
    )


def unchecked(why: str) -> None:
    """Leave the readiness phase having checked nothing, and let the assessment be attempted anyway.

    The one way this phase can cost more than it saves. It exists to stop an assessment that was
    always going to be refused; an app that is not answering has refused nothing, and failing here
    would skip a run the supervisor would have finished on its second retry. So silence is not an
    answer, and this phase only ever acts on answers.

    Said to stderr rather than passed quietly, because the assess task's own failure — if the app
    really is gone — will not mention that the check was skipped, and the run history is where
    somebody looks.
    """
    print(
        f"Nothing was checked: {why} after waiting {READINESS_WAIT_UP_TO_SECONDS}s. The assessment "
        "will be attempted, and its own retries wait longer than this task can. If the app is gone "
        "rather than restarting, that is what the assess task will report.",
        file=sys.stderr,
    )


def check_readiness() -> None:
    """Ask whether a scan would run at all, and fail this task if it would not.

    The phase exists because of what a retry costs and what it cannot fix. A refusal no retry can
    clear — this identity outside the group, no warehouse bound — arrives looking exactly like the
    failures retries exist for, and the job cannot tell them apart: it retries three times, pays a
    serverless start for each, and learns the same thing four times. Measured on labs: four attempts,
    seven and a half minutes of startup, 47 seconds of work, one answer that was never going to
    change. This task carries no retries, so that answer costs one start.

    What it must not do is turn a restart into a missed week. So this fails on an answer the app gave
    and only on that. An app that is not answering yet is waited for, briefly; an app still not
    answering when the wait runs out is handed to the assessment, which is the half of the job built
    for it. Passing on an unreachable app looks like a hole in a preflight and is the opposite: the
    worst this phase can do is refuse a week the supervisor would have completed on its second retry,
    so where it cannot get an answer it declines to have an opinion.
    """
    give_up_at = time.monotonic() + READINESS_WAIT_UP_TO_SECONDS

    while True:
        try:
            answer = call("/api/scan/readiness")
            break
        except urllib.error.HTTPError as error:
            sent, message = problem(error)
            proxy_refusal(error, message)

            # An app that predates this route. Said loudly and not failed: the assess task behaves
            # exactly as it did before this phase existed, so a version skew costs the check rather
            # than the week. The app is deployed separately from this job, so the skew is a real
            # state of a working install rather than a mistake.
            if error.code == 404:
                print(
                    "This app has no readiness route, so nothing was checked. It predates the "
                    "readiness phase; deploy the app from this bundle to have the check made. The "
                    "assessment will be attempted as it was before.",
                    file=sys.stderr,
                )
                return

            if error.code in (502, 503, 504):
                if time.monotonic() >= give_up_at:
                    unchecked(f"it is still answering HTTP {error.code}")
                    return
                print(f"The app answered HTTP {error.code}. Waiting for it to come back.")
                time.sleep(min(WAIT_SECONDS, max(0, give_up_at - time.monotonic())))
                continue

            fail(f"Could not ask the app whether a scan would run. It answered HTTP {error.code}.\n\n{message}")
        except (urllib.error.URLError, OSError) as cause:
            if time.monotonic() >= give_up_at:
                unchecked(f"it could not be reached ({cause})")
                return
            print(f"Could not reach the app ({cause}). Waiting.")
            time.sleep(min(WAIT_SECONDS, max(0, give_up_at - time.monotonic())))

    may = answer.get("may") or {}
    if not may.get("start"):
        # The app's own sentence, which names the group and says how to join it. A second phrasing
        # here would be a copy of a rule this task does not own, and the person reading the failed
        # task is the person who has to act on it.
        fail(
            f"{may.get('message', 'The app did not say why.')}\n\n"
            f"Nothing was assessed. This task ran as {answer.get('actor')} and stopped before "
            "starting a scan, so no time was spent on a run that would have been refused."
        )

    if not answer.get("warehouse"):
        fail(
            "The app has no SQL warehouse bound, so a scan would start and read none of the estate. "
            "Bind one to the app — Databricks Apps names it as a resource — and the next scheduled "
            "run will read it. Nothing was assessed."
        )

    # Not a refusal. A run still happens without records; it is a run that cannot be resumed or
    # joined, so an app replaced mid-scan costs the week rather than a retry. That is worth hearing
    # in the task output before the week it happens, and is not worth cancelling an assessment for.
    if not answer.get("runs"):
        print(
            "This app keeps no durable record of runs, so an interrupted assessment cannot be "
            "resumed and a retry would start again from nothing. Bind Lakebase to the app.",
            file=sys.stderr,
        )

    print(f"Ready. {answer.get('actor')} may start a scan, and a warehouse is bound.")


def stop_what_we_started() -> None:
    """Ask the app to stop the run, on the way out of a task somebody cancelled.

    Cancelling a job run is a person saying stop, and without this it stops only the waiting: the app
    would carry on reading the estate for a supervisor that no longer exists. So the request is
    passed on, and the app ends the run as cancelled with whatever it had reached — a terminal state
    somebody can read, rather than a run that appears to be going for ever.

    Best-effort by construction. A cancelled task is given a moment, not a guarantee, and if this
    request does not get out then the run's lease lapses and the next trigger takes it over. Failing
    here would replace "cancelled" with "failed" in the job's history and tell nobody anything.
    """
    _, run = our_run()
    if run is None:
        return
    try:
        call(f"/api/runs/{run['id']}/cancel", body={})
        print(f"Asked the app to stop run {run['id']}.")
    except (urllib.error.HTTPError, urllib.error.URLError, OSError) as cause:
        print(f"Could not ask the app to stop run {run['id']}: {cause}", file=sys.stderr)


def supervise() -> None:
    """Start the assessment, and see it through whatever happens to the connection or the app.

    The loop exists because there are three ways this task can be looking at a run it cannot see the
    end of, and none of them is a reason to fail: the app is restarting, another process holds the
    run, or the connection broke while the app was still collecting. In each case the answer is to
    wait and post the same key again, which either carries the run on or is refused because it has
    already finished — and a refusal that names a finished run carries what the run found.
    """
    give_up_at = time.monotonic() + GIVE_UP_AFTER_SECONDS
    posts = 0

    # One or the other, never both. An assessment's definition says which pillars, which workspaces and
    # how far back, so `POST /api/scan/scheduled` refuses a body that names an assessment and also sets
    # the window — a run stamped with a definition's fingerprint while measuring some other window would
    # be recorded as having asked a question it did not ask. Where no assessment is named, the job's own
    # lookback is what bounds the read, as it always was.
    body = {"definitionId": assessment_id} if assessment_id else {"lookbackDays": lookback_days}

    while True:
        posts += 1
        try:
            report(
                call(
                    "/api/scan/scheduled",
                    body=body,
                    headers={} if key is None else {"idempotency-key": key},
                )
            )
            return
        except urllib.error.HTTPError as error:
            sent, message = problem(error)
            proxy_refusal(error, message)

            # A run that came back blind: the app has already recorded it and says it is not worth
            # keeping. The summary is in the same body, so the reason and the numbers arrive together.
            if error.code == 422 and sent.get("error") == "mostly-unreadable":
                report(sent, why_blind=message)
                return

            if error.code == 409 and sent.get("error") == "run-not-joinable":
                refusal = sent.get("refusal")

                # Already finished. Where the app could still load its scan, that is the answer to
                # this task as much as to the attempt that first asked for it, and the reason this
                # exists: an attempt whose reply went missing must not report success on a run that
                # came back blind, and must not start a second assessment of the same night either.
                if refusal == "terminal":
                    if sent.get("summary") is not None:
                        report(sent["summary"])
                        return
                    fail(
                        f"{message}\n\nThe run finished but its scan is no longer on the store, so "
                        "there is nothing to report. Nothing was scanned twice; the next scheduled "
                        "run is unaffected."
                    )

                # Somebody else is working on it. Ordinary rather than exceptional: the process that
                # took the previous attempt's request may still be collecting, and it holds the work
                # this task wants the result of.
                if refusal == "held":
                    if time.monotonic() < give_up_at:
                        print(f"Run {sent['run']['id']} is held by another process. Waiting.")
                        time.sleep(WAIT_SECONDS)
                        continue
                    fail(
                        f"Run {sent['run']['id']} was held by another process for longer than this "
                        "task waits, so it was never this task's to carry on. Nothing was scanned "
                        "twice. The run page names the process holding it and when its lease lapses; "
                        "a retry of this task takes the run over once it has."
                    )

                fail(
                    f"{message}\n\nThis is the {posts}th attempt to start a run under the key "
                    f"{key}. A key that names a run belonging to another identity or describing "
                    "another request will not become joinable by retrying; the run page names both."
                )

            # A refusal about the target rather than about the estate, and the parameter to change is
            # in this job rather than in the app. The app's own sentence says what is wrong with the
            # assessment — missing, archived, or kept nowhere because this install keeps no
            # definitions — and this adds which parameter carries it, because nothing in the app knows
            # that. Retried three times regardless, since the platform's policy cannot be narrowed to a
            # class of failure; the app's schedule panel is where a reader sees it without waiting for
            # a Monday.
            if sent.get("error") in ("assessment-not-found", "assessment-archived", "assessments-unavailable"):
                fail(
                    f"{message}\n\nThis job names it in its assessment_id parameter, currently "
                    f"{assessment_id!r}. Set the bundle's schedule_assessment_id to an assessment this "
                    "app keeps and deploy, or clear it to have scheduled runs answer to none."
                )

            # The app is being restarted or replaced. The run record survives it, so waiting and
            # posting the same key again is how this task gets back to the work rather than starting
            # it over.
            if error.code in (502, 503, 504) and time.monotonic() < give_up_at:
                print(f"The app answered HTTP {error.code}. Waiting for it to come back.")
                time.sleep(WAIT_SECONDS)
                continue

            fail(f"The assessment did not complete. The app answered HTTP {error.code}.\n\n{message}")
        except (urllib.error.URLError, OSError) as cause:
            # The connection went, mid-collection. Whether the app died or the network did, the run
            # record is the thing that knows how far it got — so ask it, and post the same key again
            # to carry on from the last checkpoint.
            state, run = our_run()

            # Only one of the reasons there is no run to report is fatal. Asking failing too is what a
            # restart looks like from here rather than an answer about the run — the record cannot be
            # read because its reader is gone, not because there is nothing to read — and a key naming
            # no run yet means the connection broke before the app wrote the record, which posting the
            # key again is what fixes. An app that keeps no records is the one that cannot be waited out.
            if state == NO_STORE:
                fail(
                    f"Lost the connection to the app ({cause}), and it keeps no record of runs to "
                    "carry this one on from. Nothing was recorded, and a retry would start the "
                    "assessment again rather than resume it. Bind Lakebase to the app."
                )

            if state == UNKEYED:
                fail(
                    f"Lost the connection to the app ({cause}). This run was started by hand rather "
                    "than by the job, so it carries no key to resume under and posting again would "
                    "assess the estate a second time. The app's run page says how far it got."
                )

            if run is not None:
                where = f"Run {run['id']} is {run['state']}."
            elif state == NO_RUN:
                where = "It has no record of a run under this key yet."
            else:
                where = "It is not answering yet."

            if time.monotonic() >= give_up_at:
                fail(
                    f"Lost the connection to the app ({cause}). {where} Not seen to finish within "
                    "the time this task waits; a retry of this task carries it on from its last "
                    "checkpoint."
                )

            print(f"Lost the connection to the app ({cause}). {where} Waiting.")
            time.sleep(WAIT_SECONDS)


# Which half of the job this task is. Two tasks over one notebook rather than two notebooks, because
# everything above the phase — the parameters, the secret, the OAuth grant, the proxy's refusals, the
# way a failure is reported — is the same for both, and a second copy of it would be a second place
# for the readiness check to fall behind the run it is checking for.
phase = dbutils.widgets.get("phase").strip() or "assess"
if phase not in ("readiness", "assess"):
    raise TaskFailed(f"phase was {phase!r}. It is either readiness, to ask whether a scan would run, or assess.")

if phase == "readiness":
    check_readiness()
else:
    if key is not None:
        print(f"Supervising under key {key}.")
    print(
        f"Answering to assessment {assessment_id}."
        if assessment_id
        else "Answering to no assessment: assessment_id is empty, so this run joins no assessment's history."
    )

    try:
        supervise()
    except KeyboardInterrupt:
        # How a cancelled notebook task arrives here. Pass it on to the app, then let the interrupt do
        # what it was going to do: the task is cancelled either way, and the point of catching it is
        # that the assessment is too.
        print("This task was cancelled. Asking the app to stop the run.", file=sys.stderr)
        stop_what_we_started()
        raise
