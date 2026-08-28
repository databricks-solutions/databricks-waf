#!/usr/bin/env python3
"""Collect the security evidence no Databricks App is allowed to read.

Fifty-five security requirements in this catalogue name one of 33 control-plane endpoints that an
app install cannot reach. Not through neglect: ADR 0016 probed all 56 scopes the workspace OAuth
server publishes against the Apps scope registry, and the scopes these endpoints demand are
either refused by name or belong to the account plane, which no workspace token reaches at all.
No amount of work on the app changes that. The data is readable — by an admin, from their own
authenticated session — so this script is how it gets read.

WHAT IT DOES

Runs a fixed list of GET requests through the Databricks CLI you have already authenticated,
keeps only the specific fields each requirement needs, and writes one JSON file for the app to
import. Nothing else. No pip install, no SDK, no credential ever reaching the app.

HOW TO SATISFY YOURSELF BEFORE RUNNING IT

    python3 collect-evidence.py --dry-run --profile my-workspace

prints every endpoint it will call and every field it will keep, then exits without calling
anything. That output is the whole approval surface: the list below is the list, and there is
no code path that reaches the network with a path or a verb absent from it.

The properties worth checking against the source rather than taking on trust:

  Read-only by construction. One function reaches the network, it names the verb `get` as a
  constant, and every path is declared in PROBES. There is no POST, PUT, PATCH or DELETE
  anywhere in this file, and CI in the app's repository asserts that there is not.

  Projection, not dump. Each probe declares the exact leaf fields it keeps. A response field
  nobody declared is discarded before anything is written, so the file cannot carry an estate's
  data by accident. Where a value would be a secret or a name nobody needs, the declaration asks
  for its shape instead: `:keys` records an object's key names without their values, `:count`
  records a list's length. Cluster environment variables and library sources are captured that
  way — a `pypi.repo` can carry credentials in its URL, and the requirement only needs to know
  which kind of library it is.

  Nothing that could be a secret is fetched at all. This script never calls the endpoints that
  return secret values, init script contents, or Delta Sharing recipient tokens. Not "fetches
  and discards" — never asks.

  Partial collection degrades one requirement, not the assessment. A probe that is refused is
  recorded as `denied` with the refusal, and one that fails is recorded as `error`. Neither is
  omitted, because a missing probe and a refused one mean different things to the reader.

TWO AUTHORITIES, AND YOU MAY ONLY HAVE ONE

About a third of these requirements are account-level: audit log delivery, account console IP
access lists, network policies, workspace encryption keys. Those need an account admin and a CLI
profile pointed at the account host, which is frequently a different person from the workspace
admin. So the tiers run independently:

    python3 collect-evidence.py --profile my-workspace
    python3 collect-evidence.py --account-profile my-account

Run either, or both, in either order, by either person. Each file records which tier it carries
and under whose identity, and the app merges them and attributes every answer to the file it came
from. A tier you did not run is recorded as `skipped` rather than left out, which is what lets
the app say "this needs an account admin" instead of "no data".

USAGE

    python3 collect-evidence.py --profile WS [--account-profile ACCT] [--out FILE] [--dry-run]

Requires Python 3.9 or newer and the Databricks CLI on PATH, already authenticated. Exits 0 when
a file was written, even if some probes were refused; 2 for a usage problem; 3 when no tier could
authenticate, since a file of nothing but errors is worse than no file.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence
from urllib.parse import urlencode

# The envelope's contract with the app's importer. Bumped when a reader written against version 1
# would misread a version 2 file; the app refuses a schema it does not know rather than guessing.
SCHEMA = "waf-admin-evidence/1"

# This script's own version, recorded in every file it writes. The app publishes the checksum of
# the copy it ships, so a file produced by a modified or outdated script is flagged rather than
# quietly trusted — see `--dry-run` output, which prints both.
SCRIPT_VERSION = "1"

# The only verb this script names. Kept as a constant so there is one place to look, and so the
# repository's read-only check has something to anchor on.
VERB = "get"

# Every path a probe may name. Anchored so a path assembled from anything but a literal in the
# table below is refused before the first call rather than after it.
PATH = re.compile(r"^/api/2\.\d/[A-Za-z0-9._/{}-]+$")


# ---------------------------------------------------------------------------------------------
# The projection
#
# A probe declares the leaf fields it keeps, as paths through the response. The vocabulary is
# four things, and it is small on purpose: an approver reads the table below and knows exactly
# what leaves this workspace, without reading any code.
#
#   name.child        the value at that path, if it is a scalar or a list of scalars
#   name[].child      the same, for every element of a list
#   name:keys         the key names of an object, sorted, and none of its values
#   name:count        the number of elements in a list, and none of them
#
# A leaf that turns out to hold an object or a list of objects is a *failure*, not a value to
# copy: it means the response nests deeper than the declaration, which is either a mistake here
# or an API that changed shape. Copying it would be the dump this script exists not to be, so the
# probe is recorded as an error naming the field, and the reader finds out.
# ---------------------------------------------------------------------------------------------

#: How a probe turns a response into what it keeps.
#:
#: `projected` is the honest default and what all but six probes use. `shallow` exists for the
#: typed settings endpoints alone, where the response wraps its answer in a key named after the
#: setting rather than a fixed one, and the six spellings are not documented consistently enough
#: to declare. So those keep every scalar within two levels, minus the etag — bounded, so it is
#: not a dump, and self-describing, since the response names its own setting.
SHAPES = ("projected", "shallow")

#: Ceilings for `shallow`, so an endpoint that answers with more than a setting cannot write an
#: unbounded envelope. Exceeded means the probe records an error, same as an undeclared nesting.
SHALLOW_KEYS = 32
SHALLOW_CHARS = 512


#: Field names that may be kept as a shape and never as a value: a credential, a directory of people,
#: or a place to put either. `:keys` gives the names without the values, `:count` gives a length.
#:
#: Held here, in the script, and not only in the repository's checks — because this file's purpose is
#: to leave the repository. An admin downloads one file and runs it under their own credentials, and a
#: copy of it with an edited table is guarded by nothing that lives in a git history they will never
#: see. So it guards itself: `audit_table` runs before the first call, and refuses to collect at all
#: rather than collecting something that should not be written down.
#:
#: The repository's check keeps its own copy of this list and asserts the two agree, which is what
#: stops a name being quietly dropped from one of them.
SHAPE_ONLY = (
    "spark_env_vars",
    "library",
    "tokens",
    "members",
    "ip_addresses",
    "allowed_ip_addresses",
    "init_scripts",
)


class ProjectionError(Exception):
    """A response did not have the shape its probe declares."""


def audit_table() -> list[str]:
    """Every reason the probe table must not be used, or an empty list.

    Checks every step of every declaration rather than the last one. The difference is the hole this
    was written to close: `clusters[].spark_env_vars:keys` is the safe declaration and
    `clusters[].spark_env_vars` is caught by the projection anyway, since a plain step means a scalar
    and an object is not one. But `clusters[].spark_env_vars.DB_TOKEN` names a scalar that really is
    there, and it would have been projected, and a check reading only the final step sees `DB_TOKEN`
    and has no opinion about it. Reaching *through* one of these names is the same disclosure as
    keeping it, so the rule is about the whole path.
    """
    problems: list[str] = []
    for probe in PROBES:
        for path in probe.fields:
            for name, kind in parse_path(path):
                if name not in SHAPE_ONLY or kind in ("keys", "count"):
                    continue
                problems.append(
                    f"{probe.label} declares `{path}`, which keeps the value of `{name}`. That field can "
                    f"carry a credential or a list of people, so it may be kept only as `{name}:keys` or "
                    f"`{name}:count`."
                )
    return problems


def parse_path(path: str) -> list[tuple[str, str]]:
    """A field path as a list of (name, kind) steps, where kind is one of the four above."""
    steps: list[tuple[str, str]] = []
    for raw in path.split("."):
        if raw.endswith("[]"):
            steps.append((raw[:-2], "each"))
        elif raw.endswith(":keys"):
            steps.append((raw[: -len(":keys")], "keys"))
        elif raw.endswith(":count"):
            steps.append((raw[: -len(":count")], "count"))
        else:
            steps.append((raw, "value"))
    return steps


def project(body: Any, paths: Sequence[str]) -> Any:
    """What a probe keeps out of a response, and nothing else.

    Two rules, and the second one is load-bearing. A path nobody declared does not appear, so this
    is a keep-list and not a redaction. And a declared path the response did not carry does not
    appear either, where a path the response carried as null appears as null — because those are
    different facts and the consumer decides between them differently.

    `workspace-conf` is where that matters. It answers with one entry per key it recognises, so a
    key missing from the answer means this workspace tier does not have the setting, and a key
    answered as null means the setting exists and has never been set. The first is unmeasured; the
    second is a finding. An earlier draft wrote null for both, which would have turned twelve
    unmeasured settings on the labs workspace into twelve failures — the app inventing a finding
    out of its own lossy transport, which is the failure mode this envelope exists to avoid.

    The consumer reconstructs "asked for and not answered" by taking `fields` minus what is here,
    which is why `fields` is recorded on every probe.
    """
    out: dict[str, Any] = {}
    for path in paths:
        steps = parse_path(path)
        # A path that starts with `[]` says the response itself is the list, which the account
        # APIs do. Held as one key so the shape of what is written stays an object either way.
        if steps and steps[0][0] == "" and steps[0][1] == "each":
            place(out, {"": body}, steps, path)
        else:
            place(out, body, steps, path)
    return out


def place(out: dict[str, Any], value: Any, steps: Sequence[tuple[str, str]], path: str) -> None:
    """Copy one declared path out of `value` into `out`, following the declaration's shape."""
    name, kind = steps[0]
    rest = steps[1:]
    if not isinstance(value, Mapping) or name not in value:
        # Nothing written, which is how an unanswered key is told apart from one answered as null.
        # Checked with `in` rather than by comparing `get` against None for exactly that reason.
        return
    got = value[name]

    if kind == "keys":
        if got is not None and not isinstance(got, Mapping):
            raise ProjectionError(f"{path} asked for the key names of {type(got).__name__}")
        out[f"{name}:keys"] = None if got is None else sorted(got.keys())
        return

    if kind == "count":
        if got is not None and not isinstance(got, (list, tuple)):
            raise ProjectionError(f"{path} asked for the length of {type(got).__name__}")
        out[f"{name}:count"] = None if got is None else len(got)
        return

    if kind == "each":
        if got is None:
            out[name or "items"] = None
            return
        if not isinstance(got, (list, tuple)):
            raise ProjectionError(f"{path} expected a list and found {type(got).__name__}")
        key = name or "items"
        rows = out.setdefault(key, [])
        if not isinstance(rows, list):
            raise ProjectionError(f"{path} conflicts with another declaration of {key}")
        while len(rows) < len(got):
            rows.append({})
        for row, element in zip(rows, got):
            place(row, element, rest, path)
        return

    if rest:
        if got is None:
            # Answered as null, so recorded as null. Recursing into an empty object instead would
            # write `{}` here and lose the difference between a null object and one with no
            # declared children in it.
            out[name] = None
            return
        child = out.setdefault(name, {})
        if not isinstance(child, dict):
            raise ProjectionError(f"{path} conflicts with another declaration of {name}")
        place(child, got if isinstance(got, Mapping) else {}, rest, path)
        return

    out[name] = leaf(got, path)


def leaf(value: Any, path: str) -> Any:
    """A declared leaf, or a refusal if the response put something deeper there."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (list, tuple)):
        if all(element is None or isinstance(element, (str, int, float, bool)) for element in value):
            return list(value)
        raise ProjectionError(f"{path} is a list of objects, which no declaration covers")
    raise ProjectionError(f"{path} is an object, which nests deeper than the declaration")


def shallow(body: Any) -> Any:
    """Every scalar within two levels of a typed setting's response, minus its etag."""
    if not isinstance(body, Mapping):
        raise ProjectionError("a typed setting answered with something other than an object")

    out: dict[str, Any] = {}
    for key in sorted(body.keys()):
        if key == "etag":
            continue
        if len(out) >= SHALLOW_KEYS:
            raise ProjectionError(f"a typed setting answered with more than {SHALLOW_KEYS} fields")
        value = body[key]
        if isinstance(value, Mapping):
            out[key] = {
                inner: cap(value[inner])
                for inner in sorted(value.keys())
                if not isinstance(value[inner], (Mapping, list, tuple))
            }
        elif isinstance(value, (list, tuple)):
            out[f"{key}:count"] = len(value)
        else:
            out[key] = cap(value)
    return out


def cap(value: Any) -> Any:
    """A scalar, with a long string truncated, so no single field can carry a payload."""
    if isinstance(value, str) and len(value) > SHALLOW_CHARS:
        return value[:SHALLOW_CHARS] + "\u2026"
    return value


# ---------------------------------------------------------------------------------------------
# The probes
#
# One entry per call. `signals` are the catalogue's own collector ids, which is how the app knows
# which requirements a probe answers — usually one id, occasionally two where the catalogue names
# the same call from both planes. `controls` is there for the approver rather than the app: it
# says which requirement asked for this field, so "why do you need the token list" has an answer
# in the dry-run output instead of in a conversation.
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Probe:
    #: Catalogue collector ids this call answers.
    signals: tuple[str, ...]
    #: Which authority the call needs: a workspace admin, or an account admin.
    tier: str
    #: Short name, used in the log and as the key a reader looks for.
    label: str
    #: What is being read, as a sentence subject: "… was refused".
    what: str
    #: The GET path. `{account_id}` is filled from the profile; `{variant}` from `variants`.
    path: str
    #: Requirements this answers, so the dry-run can say why the call is being made.
    controls: tuple[str, ...]
    #: Declared leaf fields. Empty only for `shallow`.
    fields: tuple[str, ...] = ()
    query: tuple[tuple[str, str], ...] = ()
    variants: tuple[str, ...] = ()
    shape: str = "projected"


#: The workspace settings the flag requirements read, spelled as the endpoint spells them.
#:
#: Kept in one list because the endpoint answers them in one call: sixteen requirements, one
#: request. The app's `settings-keys.ts` holds the same list with what an unset value means for
#: each, and CI asserts the two agree — a key added there and forgotten here would report as a
#: requirement the admin script silently stopped answering.
SETTINGS_KEYS = (
    "enableIpAccessLists",
    "enableVerboseAuditLogs",
    "enableJobViewAcls",
    "enforceClusterViewAcls",
    "enforceWorkspaceViewAcls",
    "enableProjectsAllowList",
    "enableResultsDownloading",
    "enableExportNotebook",
    "enableNotebookTableClipboard",
    "enableDbfsFileBrowser",
    "enableFileStoreEndpoint",
    "storeInteractiveNotebookResultsInCustomerAccount",
    "enableEnforceImdsV2",
    "enableProjectTypeInWorkspace",
    "maxTokenLifetimeDays",
)

WORKSPACE_PROBES: tuple[Probe, ...] = (
    Probe(
        signals=("rest:workspace:preview.workspace-conf",),
        tier="workspace",
        label="workspace-conf",
        what="The workspace security settings",
        path="/api/2.0/workspace-conf",
        query=(("keys", ",".join(SETTINGS_KEYS)),),
        controls=(
            "SCP-01-04",
            "SCP-01-05",
            "SCP-02-04",
            "SCP-02-05",
            "SCP-02-06",
            "SCP-02-07",
            "SCP-02-08",
            "SCP-02-12",
            "SCP-03-10",
            "SCP-04-08",
            "SCP-04-09",
            "SCP-05-04",
            "SCP-05-05",
            "SCP-05-06",
            "SCP-05-07",
            "SCP-05-15",
        ),
        # Exactly the keys asked for, so a response carrying anything else is discarded. The
        # endpoint answers with an object keyed by setting name, so the declaration is the list.
        fields=SETTINGS_KEYS,
    ),
    Probe(
        signals=("rest:workspace:token.list",),
        tier="workspace",
        label="token-management",
        what="The workspace personal access tokens",
        path="/api/2.0/token-management/tokens",
        controls=("SCP-01-03", "SCP-01-05", "SCP-04-01"),
        # Never a token value: this endpoint does not return one, and the declaration means a
        # future version of it that did would still not be written to the file.
        fields=(
            "token_infos[].token_id",
            "token_infos[].created_by_username",
            "token_infos[].comment",
            "token_infos[].creation_time",
            "token_infos[].expiry_time",
        ),
    ),
    Probe(
        signals=("rest:workspace:permissions.authorization.tokens",),
        tier="workspace",
        label="token-permissions",
        what="Who may create personal access tokens",
        path="/api/2.0/permissions/authorization/tokens",
        controls=("SCP-01-06",),
        fields=(
            "access_control_list[].user_name",
            "access_control_list[].group_name",
            "access_control_list[].service_principal_name",
            "access_control_list[].all_permissions[].permission_level",
        ),
    ),
    Probe(
        signals=("rest:workspace:clusters.list",),
        tier="workspace",
        label="clusters",
        what="The workspace clusters",
        path="/api/2.0/clusters/list",
        controls=("SCP-02-02", "SCP-04-03"),
        fields=(
            "clusters[].cluster_id",
            "clusters[].cluster_name",
            "clusters[].state",
            "clusters[].cluster_source",
            "clusters[].spark_version",
            "clusters[].data_security_mode",
            "clusters[].autotermination_minutes",
            "clusters[].enable_local_disk_encryption",
            "clusters[].start_time",
            "clusters[].last_restarted_time",
            # Key names only. A cluster environment variable is a classic place to find a
            # hard-coded credential, which is exactly why its value is never captured.
            "clusters[].spark_env_vars:keys",
            "clusters[].init_scripts:count",
        ),
    ),
    Probe(
        signals=("rest:workspace:libraries.all-cluster-statuses",),
        tier="workspace",
        label="cluster-libraries",
        what="The libraries installed on clusters",
        path="/api/2.0/libraries/all-cluster-statuses",
        controls=("SCP-05-01",),
        fields=(
            "statuses[].cluster_id",
            "statuses[].library_statuses[].status",
            "statuses[].library_statuses[].is_library_for_all_clusters",
            # Which kind of library, not which one. `library` is an object whose single key is
            # the type — `pypi`, `maven`, `jar` — and its value can carry an index URL with
            # credentials in it. The requirement only needs the type.
            "statuses[].library_statuses[].library:keys",
        ),
    ),
    Probe(
        signals=("rest:workspace:global-init-scripts",),
        tier="workspace",
        label="global-init-scripts",
        what="The global init scripts",
        path="/api/2.0/global-init-scripts",
        controls=("SCP-05-02",),
        # The list endpoint, never the get-by-id that returns a script's contents. A global init
        # script is a place people put credentials, and the requirement is answered by its
        # existence and whether it is enabled.
        fields=(
            "scripts[].script_id",
            "scripts[].name",
            "scripts[].enabled",
            "scripts[].position",
        ),
    ),
    Probe(
        signals=("rest:workspace:secrets.scopes.list",),
        tier="workspace",
        label="secret-scopes",
        what="The secret scopes",
        path="/api/2.0/secrets/scopes/list",
        controls=("SCP-02-01",),
        # Scopes, and nothing inside them. This script never calls `secrets/get` or `secrets/list`.
        fields=("scopes[].name", "scopes[].backend_type"),
    ),
    Probe(
        signals=("rest:workspace:ip-access-lists",),
        tier="workspace",
        label="ip-access-lists",
        what="The workspace IP access lists",
        path="/api/2.0/ip-access-lists",
        controls=("SCP-03-05",),
        fields=(
            "ip_access_lists[].label",
            "ip_access_lists[].list_type",
            "ip_access_lists[].enabled",
            "ip_access_lists[].ip_addresses:count",
        ),
    ),
    Probe(
        signals=("rest:workspace:preview.scim.v2.Groups",),
        tier="workspace",
        label="scim-groups",
        what="The workspace groups",
        path="/api/2.0/preview/scim/v2/Groups",
        controls=("SCP-05-03",),
        # How many admins, not who they are. The requirement is a count against a threshold, and
        # a list of names would be an export of the workspace's directory.
        fields=("Resources[].id", "Resources[].displayName", "Resources[].members:count"),
    ),
    Probe(
        signals=("rest:workspace:jobs.list",),
        tier="workspace",
        label="jobs",
        what="The workspace jobs",
        path="/api/2.1/jobs/list",
        query=(("limit", "100"), ("expand_tasks", "false")),
        controls=("SCP-04-22",),
        fields=(
            "jobs[].job_id",
            "jobs[].settings.name",
            "jobs[].run_as_user_name",
            "jobs[].settings.run_as.user_name",
            "jobs[].settings.run_as.service_principal_name",
        ),
    ),
    Probe(
        signals=("rest:workspace:dbfs.list",),
        tier="workspace",
        label="hive-warehouse",
        what="The DBFS root managed table directory",
        path="/api/2.0/dbfs/list",
        query=(("path", "/user/hive/warehouse"),),
        controls=("SCP-04-05",),
        # Directory names and sizes at one level. Never a file's contents: this script does not
        # call `dbfs/read`.
        fields=("files[].path", "files[].is_dir", "files[].file_size"),
    ),
    Probe(
        signals=("rest:workspace:unity-catalog.metastores",),
        tier="workspace",
        label="uc-metastores",
        what="The Unity Catalog metastores",
        path="/api/2.1/unity-catalog/metastores",
        controls=("SCP-04-15",),
        fields=(
            "metastores[].metastore_id",
            "metastores[].name",
            "metastores[].owner",
            "metastores[].created_by",
            "metastores[].delta_sharing_scope",
        ),
    ),
    Probe(
        signals=("rest:workspace:unity-catalog.metastore_summary",),
        tier="workspace",
        label="uc-metastore-summary",
        what="The metastore this workspace is attached to",
        path="/api/2.1/unity-catalog/metastore_summary",
        controls=("SCP-04-11",),
        fields=(
            "metastore_id",
            "name",
            "delta_sharing_scope",
            "delta_sharing_recipient_token_lifetime_in_seconds",
            "privilege_model_version",
        ),
    ),
    Probe(
        signals=("rest:workspace:unity-catalog.storage-credentials",),
        tier="workspace",
        label="uc-storage-credentials",
        what="The Unity Catalog storage credentials",
        path="/api/2.1/unity-catalog/storage-credentials",
        controls=("SCP-05-08",),
        # Names and flags. The cloud identity a credential wraps is not captured, and no endpoint
        # here returns the credential itself.
        fields=(
            "storage_credentials[].id",
            "storage_credentials[].name",
            "storage_credentials[].read_only",
            "storage_credentials[].isolation_mode",
            "storage_credentials[].used_for_managed_storage",
        ),
    ),
    Probe(
        signals=("rest:workspace:unity-catalog.models",),
        tier="workspace",
        label="uc-models",
        what="The registered models in Unity Catalog",
        path="/api/2.1/unity-catalog/models",
        controls=("SCP-04-17",),
        fields=(
            "registered_models[].full_name",
            "registered_models[].metastore_id",
            "registered_models[].browse_only",
        ),
    ),
    Probe(
        signals=("rest:workspace:unity-catalog.recipients",),
        tier="workspace",
        label="uc-recipients",
        what="The Delta Sharing recipients",
        path="/api/2.1/unity-catalog/recipients",
        controls=("SCP-04-12", "SCP-04-13"),
        # Deliberately not `tokens`: a recipient's token object carries the activation URL, which
        # is a bearer credential for the share. The requirements need whether an expiry and an IP
        # allowlist exist, which the count and the expiry field answer.
        fields=(
            "recipients[].name",
            "recipients[].authentication_type",
            "recipients[].activated",
            "recipients[].expiration_time",
            "recipients[].ip_access_list.allowed_ip_addresses:count",
            "recipients[].tokens:count",
        ),
    ),
    Probe(
        signals=("rest:workspace:unity-catalog.artifact-allowlists.{artifact_type}",),
        tier="workspace",
        label="uc-artifact-allowlists",
        what="The Unity Catalog artifact allowlists",
        path="/api/2.1/unity-catalog/artifact-allowlists/{variant}",
        # Two known types rather than a discovered set, which is why this is a call and not a
        # fan-out: the requirement names both.
        variants=("LIBRARY_JAR", "LIBRARY_MAVEN"),
        controls=("SCP-05-12",),
        fields=(
            "artifact_matchers[].artifact",
            "artifact_matchers[].match_type",
            "created_at",
        ),
    ),
    # The six typed settings. One endpoint shape, six setting names, and `shallow` because the
    # response wraps its answer in a key named after the setting rather than a fixed one.
    Probe(
        signals=("rest:workspace:settings.types.automatic_cluster_update.names.default",),
        tier="workspace",
        label="setting-automatic-cluster-update",
        what="The automatic cluster update setting",
        path="/api/2.0/settings/types/automatic_cluster_update/names/default",
        controls=("SCP-04-20",),
        shape="shallow",
    ),
    Probe(
        signals=("rest:workspace:settings.types.restrict_workspace_admins.names.default",),
        tier="workspace",
        label="setting-restrict-workspace-admins",
        what="The restrict workspace admins setting",
        path="/api/2.0/settings/types/restrict_workspace_admins/names/default",
        controls=("SCP-04-19",),
        shape="shallow",
    ),
    Probe(
        signals=("rest:workspace:settings.types.disable_legacy_dbfs.names.default",),
        tier="workspace",
        label="setting-disable-legacy-dbfs",
        what="The disable legacy DBFS setting",
        path="/api/2.0/settings/types/disable_legacy_dbfs/names/default",
        controls=("SCP-02-10",),
        shape="shallow",
    ),
    Probe(
        signals=("rest:workspace:settings.types.sql_results_download.names.default",),
        tier="workspace",
        label="setting-sql-results-download",
        what="The SQL results download setting",
        path="/api/2.0/settings/types/sql_results_download/names/default",
        controls=("SCP-02-11",),
        shape="shallow",
    ),
    Probe(
        signals=("rest:workspace:settings.types.shield_csp_enablement_ws_db.names.default",),
        tier="workspace",
        label="setting-compliance-security-profile",
        what="The compliance security profile setting",
        path="/api/2.0/settings/types/shield_csp_enablement_ws_db/names/default",
        controls=("SCP-05-13",),
        shape="shallow",
    ),
    Probe(
        signals=("rest:workspace:settings.types.shield_esm_enablement_ws_db.names.default",),
        tier="workspace",
        label="setting-enhanced-security-monitoring",
        what="The enhanced security monitoring setting",
        path="/api/2.0/settings/types/shield_esm_enablement_ws_db/names/default",
        controls=("SCP-05-14",),
        shape="shallow",
    ),
)

ACCOUNT_PROBES: tuple[Probe, ...] = (
    Probe(
        # Two catalogue ids, one call: the workspace-plane requirement about secure cluster
        # connectivity reads the workspace's own record from the account API, so the catalogue
        # names it from both planes. The authority needed is the account's either way.
        signals=("rest:account:accounts.workspaces", "rest:workspace:accounts.workspaces"),
        tier="account",
        label="account-workspaces",
        what="The workspaces in this account and how they are networked",
        path="/api/2.0/accounts/{account_id}/workspaces",
        controls=("SCP-02-03", "SCP-03-03", "SCP-03-04", "SCP-03-06"),
        # The response is a bare list, which `[]` says.
        fields=(
            "[].workspace_id",
            "[].workspace_name",
            "[].deployment_name",
            "[].workspace_status",
            "[].network_id",
            "[].private_access_settings_id",
            "[].storage_customer_managed_key_id",
            "[].managed_services_customer_managed_key_id",
        ),
    ),
    Probe(
        signals=("rest:account:accounts.{account_id}.ip-access-lists",),
        tier="account",
        label="account-ip-access-lists",
        what="The account console IP access lists",
        path="/api/2.0/accounts/{account_id}/ip-access-lists",
        controls=("SCP-03-08", "SCP-03-12"),
        fields=(
            "ip_access_lists[].label",
            "ip_access_lists[].list_type",
            "ip_access_lists[].enabled",
            "ip_access_lists[].ip_addresses:count",
        ),
    ),
    Probe(
        signals=("rest:account:accounts.network-policies",),
        tier="account",
        label="account-network-policies",
        what="The account network policies",
        path="/api/2.0/accounts/{account_id}/network-policies",
        controls=("SCP-03-09", "SCP-03-11"),
        fields=(
            "items[].network_policy_id",
            "items[].egress.network_access.restriction_mode",
            "items[].egress.network_access.policy_enforcement.enforcement_mode",
        ),
    ),
    Probe(
        signals=("rest:account:accounts.log-delivery",),
        tier="account",
        label="account-log-delivery",
        what="The account log delivery configurations",
        path="/api/2.0/accounts/{account_id}/log-delivery",
        controls=("SCP-04-02",),
        fields=(
            "log_delivery_configurations[].config_id",
            "log_delivery_configurations[].config_name",
            "log_delivery_configurations[].log_type",
            "log_delivery_configurations[].output_format",
            "log_delivery_configurations[].status",
            "log_delivery_configurations[].workspace_ids_filter:count",
        ),
    ),
    Probe(
        signals=("rest:account:accounts.settings.types.disable_legacy_features.names.default",),
        tier="account",
        label="account-setting-disable-legacy-features",
        what="The disable legacy features account setting",
        path="/api/2.0/accounts/{account_id}/settings/types/disable_legacy_features/names/default",
        controls=("SCP-04-21",),
        shape="shallow",
    ),
    Probe(
        signals=("rest:account:accounts.settings.types.shield_csp_enablement_ac.names.default",),
        tier="account",
        label="account-setting-compliance-security-profile",
        what="The compliance security profile account setting",
        path="/api/2.0/accounts/{account_id}/settings/types/shield_csp_enablement_ac/names/default",
        controls=("SCP-05-11",),
        shape="shallow",
    ),
)

PROBES: tuple[Probe, ...] = WORKSPACE_PROBES + ACCOUNT_PROBES

#: Requirements this script does not yet answer, and why.
#:
#: Recorded here rather than left out, because the accounting is the point: the app's CI asserts
#: that every requirement no install can reach is either probed above or named here. A requirement
#: that quietly belongs to neither list is one the reader is told is coming, from a script that
#: was never going to make the call.
DEFERRED: tuple[tuple[str, str], ...] = (
    (
        "rest:workspace:permissions.jobs.{job_id}",
        "One call per job. A fan-out over the job list is a different shape of script — bounded, "
        "paged and slow enough to need a progress line — and putting it in the first version "
        "would make the whole collection as slow as the largest estate's job count.",
    ),
    (
        "rest:workspace:unity-catalog.permissions.{securable_type}.{full_name}",
        "Needs the metastore id from another probe before the path can be built, which makes it "
        "the first probe that depends on another. Sequencing that is worth doing once, for the "
        "several requirements that will need it, rather than as a special case here.",
    ),
    (
        "rest:account:accounts.servicePrincipals.credentials.secrets",
        "One call per account service principal, so the same fan-out as job permissions and the "
        "same reason. The list of service principals is itself an account-plane call this script "
        "does not make yet.",
    ),
)


# ---------------------------------------------------------------------------------------------
# The digest
#
# The envelope carries a SHA-256 over the probe set so the app can say whether the file it is
# importing is the file that was collected. That is only worth recording if the same probe set
# hashes to the same value on both sides, and `json.dumps` does not promise that — the app parses
# the file, stores it, reads it back, and gets its keys in whatever order its database hands them
# over.
#
# So the digest is over a canonical form, and the form is RFC 8785 (JSON Canonicalisation Scheme)
# rather than one invented here. Two reasons. The app implements the same standard, in TypeScript,
# and its CI runs both over the same fixtures and compares the bytes — a private convention would
# have made that check a comparison of this file against itself. And an admin who wants to verify
# the digest without either implementation can reach for a JCS library in whatever language they
# audit in.
#
# The awkward part is numbers. RFC 8785 serialises them as ECMAScript does, which is not how
# Python does: Python prints 1e20 as `1e+20` where JavaScript prints it in full, and switches to
# exponent form four orders of magnitude earlier. `js_number` below is the ECMAScript algorithm
# spelled out, and the app's CI checks it against the real thing on the values where the two
# conventions differ.
# ---------------------------------------------------------------------------------------------

MAX_DEPTH = 64

_ESCAPES = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
}


class CanonicalisationError(Exception):
    """A value that JSON cannot represent, or that this is not willing to guess about."""


def canonicalise(value: Any) -> str:
    out: list[str] = []
    _write(value, out, 0)
    return "".join(out)


def digest(value: Any) -> str:
    """The digest of a document, prefixed with its algorithm so a future one can be told apart."""
    return "sha256:" + hashlib.sha256(canonicalise(value).encode("utf-8")).hexdigest()


def _write(value: Any, out: list[str], depth: int) -> None:
    if depth > MAX_DEPTH:
        raise CanonicalisationError(f"a document nested more than {MAX_DEPTH} levels deep")

    if value is None:
        out.append("null")
        return
    # Before the int check: in Python a bool is an int, and `True` would otherwise serialise as 1.
    if value is True:
        out.append("true")
        return
    if value is False:
        out.append("false")
        return
    if isinstance(value, str):
        out.append(js_string(value))
        return
    if isinstance(value, (int, float)):
        out.append(js_number(value))
        return
    if isinstance(value, (list, tuple)):
        out.append("[")
        for at, element in enumerate(value):
            if at > 0:
                out.append(",")
            _write(element, out, depth + 1)
        out.append("]")
        return
    if isinstance(value, Mapping):
        out.append("{")
        first = True
        # Sorted by UTF-16 code unit, which is the format's rule and not Python's default. Big-
        # endian bytes compare in the same order as the code units they encode, so encoding is
        # the sort key. It differs from sorting by code point only above the BMP — an emoji in a
        # cluster name is enough to reach it, and a digest that disagreed with the app's for that
        # reason would be reported to the reader as a tampered file.
        for key in sorted(value.keys(), key=lambda name: str(name).encode("utf-16-be")):
            if not isinstance(key, str):
                raise CanonicalisationError(f"an object key of type {type(key).__name__}")
            if not first:
                out.append(",")
            first = False
            out.append(js_string(key))
            out.append(":")
            _write(value[key], out, depth + 1)
        out.append("}")
        return

    raise CanonicalisationError(f"a {type(value).__name__}, which is not JSON data")


def js_string(value: str) -> str:
    """A string escaped as `JSON.stringify` escapes one: short forms, then \\u for the rest."""
    out = ['"']
    for character in value:
        if character in _ESCAPES:
            out.append(_ESCAPES[character])
        elif character < " " or "\ud800" <= character <= "\udfff":
            out.append("\\u%04x" % ord(character))
        else:
            out.append(character)
    out.append('"')
    return "".join(out)


def js_number(value: float) -> str:
    """A number as ECMAScript prints it, which is what RFC 8785 asks for.

    An integer is converted to a double first, deliberately. The app reads this file with
    `JSON.parse`, where every number is a double already, so an integer beyond 2^53 is rounded
    before it is ever hashed on that side. Rounding here too is what makes the two digests agree;
    not rounding would produce a file that reports itself as altered on arrival.
    """
    number = float(value)
    if number != number or number in (float("inf"), float("-inf")):
        raise CanonicalisationError(f"{value}, which JSON cannot represent")
    # Covers -0.0, which prints as 0: JSON has no signed zero, and a digest that depended on one
    # would flip the first time a value went through arithmetic that normalised it.
    if number == 0:
        return "0"
    if number < 0:
        return "-" + js_number(-number)

    digits, point = _decimal(number)
    length = len(digits)

    # The four forms ECMAScript uses, in its own order. `point` is where the decimal point sits
    # relative to the start of the digits, so 100 is digits "1" with point 3.
    if length <= point <= 21:
        return digits + "0" * (point - length)
    if 0 < point <= 21:
        return digits[:point] + "." + digits[point:]
    if -6 < point <= 0:
        return "0." + "0" * (-point) + digits

    exponent = point - 1
    mantissa = digits if length == 1 else digits[0] + "." + digits[1:]
    return f"{mantissa}e{'+' if exponent >= 0 else '-'}{abs(exponent)}"


def _decimal(number: float) -> tuple[str, int]:
    """The shortest round-trip digits of a positive double, and where its point sits.

    `repr` gives the shortest digits that read back as the same double, which is the same set
    ECMAScript uses. Only the arrangement differs, and that is what `js_number` fixes.
    """
    text = repr(number)
    mantissa, _, exponent = text.partition("e")
    shift = int(exponent) if exponent else 0
    whole, _, fraction = mantissa.partition(".")

    all_digits = whole + fraction
    stripped = all_digits.lstrip("0")
    leading = len(all_digits) - len(stripped)
    point = len(whole) + shift - leading
    return stripped.rstrip("0") or "0", point


# ---------------------------------------------------------------------------------------------
# The one place that reaches the network
# ---------------------------------------------------------------------------------------------

#: How long one call may take before it is recorded as an error rather than waited on.
TIMEOUT_SECONDS = 60

#: Anything long and token-shaped in a CLI error message, replaced before it is written to a file
#: that will be emailed to somebody. The CLI does not print credentials today; this is so that a
#: version of it that did could not turn this file into a leak.
SECRETS = re.compile(r"\b(?:db[a-z]{0,4}|ey|dapi|sql)[A-Za-z0-9_\-.]{24,}\b")

#: What a refusal looks like, as against a failure. Told apart because they mean different things
#: to the reader: a refusal names a grant somebody can make, and a failure names a bug or an
#: endpoint that moved.
#:
#: `access is denied` was added after the first real run. `GET /api/2.0/dbfs/list` on a workspace with
#: the public DBFS root switched off answers `Public DBFS root is disabled. Access is denied on path:
#: /user/hive/warehouse`, which matched nothing here and was recorded as an error — so the one
#: requirement about managed tables in the DBFS root reported a failure to measure, on a workspace
#: whose answer is the strongest one available. The detail is kept verbatim either way, and what that
#: sentence *means* is the resolver's to decide: a script that promoted a refusal to a pass would be
#: scoring, which is not its job.
REFUSAL = re.compile(
    r"\b(?:401|403|PERMISSION_DENIED|Unauthorized|does not have|not authorized"
    r"|access is denied|is not an? (?:account|workspace) admin)\b",
    re.IGNORECASE,
)


class CallOutcome:
    """One call's result: its body, or why there is none."""

    def __init__(self, status: str, body: Any = None, detail: str | None = None) -> None:
        self.status = status
        self.body = body
        self.detail = detail


def run(command: Sequence[str], timeout: int = TIMEOUT_SECONDS) -> tuple[Any, str | None]:
    """Start a process, and hand back what it said or why it said nothing.

    The only place in this file that starts one. That is worth more than the three call sites it
    replaces: there is a single argument list to inspect, a single absence of `shell=True` to
    assert, and no way to add a fourth kind of invocation without editing this function. The
    repository's read-only check anchors on exactly that.
    """
    try:
        finished = subprocess.run(  # noqa: S603 - a fixed argument list, never a shell
            list(command),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError:
        return None, f"{command[0]} is not on PATH"
    except subprocess.TimeoutExpired:
        return None, f"{command[0]} did not return within {timeout} seconds"
    return finished, None


def call(binary: str, path: str, query: Sequence[tuple[str, str]], account: bool, profile: str) -> CallOutcome:
    """Make the one kind of request this script makes.

    Every network call in this file goes through here, and the verb is a constant. There is no
    argument that could make it anything else, which is the property `--dry-run` lets an approver
    check and the repository's read-only test asserts.
    """
    if not PATH.match(path):
        # Cannot happen from the table, which is the point of checking: it means a path was
        # assembled from something other than a literal above.
        return CallOutcome("error", detail=f"{path} is not a shape this script is allowed to request")

    target = path + ("?" + urlencode(list(query)) if query else "")
    command = [binary, "api", VERB, target, "--profile", profile, "--output", "json"]
    if account:
        command.append("--account")

    finished, problem = run(command)
    if finished is None:
        return CallOutcome("error", detail=problem)

    if finished.returncode != 0:
        detail = redact(finished.stderr.strip() or finished.stdout.strip())
        return CallOutcome("denied" if REFUSAL.search(detail) else "error", detail=detail[:600])

    text = finished.stdout.strip()
    # An empty body is a real answer from the settings endpoints: nothing has been configured.
    if text == "":
        return CallOutcome("observed", body={})
    try:
        return CallOutcome("observed", body=json.loads(text))
    except json.JSONDecodeError as problem:
        return CallOutcome("error", detail=f"the response was not JSON: {problem}")


def redact(text: str) -> str:
    return SECRETS.sub("<redacted>", text)


def cli_version(binary: str) -> str | None:
    finished, _ = run([binary, "--version"], timeout=30)
    return None if finished is None else finished.stdout.strip() or None


#: The `✓ key: value (from where)` lines of `auth describe` without `--output json`, and the `User:`
#: line above them.
#:
#: Parsed as a fallback, and the fallback is not hypothetical: on CLI 1.1.0 the JSON form fails
#: outright for an account profile — `Error: json: unsupported type: func() (io.ReadCloser, error)`,
#: exit 1, no output — while the account API calls that same profile authorises work perfectly. A
#: script that gave up there would refuse the entire account tier, which is the half of this evidence
#: that only an account admin can collect, over a serialisation bug in one command.
SETTING = re.compile(
    r"^\s*[^\w\s]?\s*(host|account_id|workspace_id|auth_type|profile)\s*:\s*(.+?)(?:\s+\(from .*\))?\s*$"
)
USER = re.compile(r"^\s*User\s*:\s*(.+?)\s*$")


def note(found: dict[str, Any], key: str, value: Any) -> None:
    """Record one identity field, if it is a field this asks for and is not already answered.

    First answer wins, which is what makes the JSON reading authoritative and the text reading a
    gap-filler rather than a competitor. `none` is the CLI's word for an absent id and is treated as
    absent, so an account profile does not come out claiming to be workspace `none`.
    """
    if key not in found or found[key] is not None:
        return
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        return
    text = str(value).strip()
    if text == "" or text.lower() == "none":
        return
    found[key] = text


def from_json(text: str, found: dict[str, Any]) -> str | None:
    """Fill `found` from `auth describe --output json`, and return its error if it reported one.

    The paths here are the ones the CLI actually uses, which are not the ones an earlier version of
    this script guessed at. `username` is at the top level, not under `details`; the ids live under
    `details.configuration` as `{value, source}` pairs rather than as plain fields. Reading the wrong
    paths failed silently — a file was still written, with every identity field blank — and blank is
    precisely the part the app's import holds the file against when deciding whether this evidence
    describes the estate under assessment. Found by running it, not by reading it.
    """
    try:
        described = json.loads(text or "{}")
    except json.JSONDecodeError:
        return None
    if not isinstance(described, Mapping) or len(described) == 0:
        # Nothing was said, which is not the same as an error being reported. The distinction cost
        # the account tier entirely on the first run against a real profile: the command failed on
        # stderr with an empty stdout, this read `{}`, saw no `"status": "success"` in it, and
        # manufactured an error of `""` — and one line up in `main`, any error at all skips every
        # probe in the tier. An empty string is not a reason, so it must not become one.
        return None

    details = described.get("details")
    details = details if isinstance(details, Mapping) else {}
    configuration = details.get("configuration")
    configuration = configuration if isinstance(configuration, Mapping) else {}

    note(found, "username", described.get("username"))
    for key in ("host", "auth_type"):
        note(found, key, details.get(key))
    for key in ("host", "account_id", "workspace_id", "auth_type", "profile"):
        entry = configuration.get(key)
        note(found, key, entry.get("value") if isinstance(entry, Mapping) else entry)

    if described.get("status") == "success":
        return None
    stated = described.get("error")
    if stated is None or stated == "":
        return None
    return redact(stated if isinstance(stated, str) else json.dumps(stated))[:300]


def from_text(text: str, found: dict[str, Any]) -> None:
    """Fill `found` from the human-readable `auth describe`, for when the JSON form will not run."""
    for line in text.splitlines():
        user = USER.match(line)
        if user is not None:
            note(found, "username", user.group(1))
            continue
        setting = SETTING.match(line)
        if setting is not None:
            note(found, setting.group(1), setting.group(2))


def identity(binary: str, profile: str, account: bool) -> dict[str, Any]:
    """Who is collecting, and against what.

    Read from the CLI rather than asked for, so the file records the authority that actually made
    the calls instead of what somebody typed. `--sensitive` is deliberately not passed: this needs
    the identity, never the credential.
    """
    found: dict[str, Any] = {
        "profile": profile,
        "host": None,
        "account_id": None,
        "workspace_id": None,
        "username": None,
        "auth_type": None,
    }
    describe = [binary, "auth", "describe", "--profile", profile]

    structured, problem = run([*describe, "--output", "json"], timeout=60)
    reported = None if structured is None else from_json(structured.stdout, found)
    read = "json" if found["host"] is not None else None

    # Asked a second way only when the first left something the import needs. The two readings are
    # of the same command, so this costs a second of wall clock on the path that already failed and
    # nothing at all on the path that did not.
    if found["host"] is None or found["account_id"] is None:
        plain, problem = run(describe, timeout=60)
        if plain is not None:
            from_text(plain.stdout, found)
            if found["host"] is not None:
                read = "json+text" if read == "json" else "text"

    found["read"] = read
    if reported is not None:
        found["error"] = reported
    elif read is None:
        found["error"] = problem or "the CLI could not describe this profile, so nothing identifies who collected this"
    if account and found["account_id"] is None:
        found["error"] = (
            "this profile has no account id, so it cannot be used for the account tier. An account "
            "profile has `host = https://accounts.<cloud>.databricks.com` and `account_id` set."
        )
    return found


# ---------------------------------------------------------------------------------------------
# Collecting
# ---------------------------------------------------------------------------------------------

#: A response field that says the endpoint had more to give than one call returns. Recorded rather
#: than followed: a truncated probe answers its requirement about what was seen and says so, which
#: is better than a script that pages for an hour on the largest estate and is killed halfway.
PAGE_MARKERS = ("next_page_token", "next_page", "has_more")


def endpoint_of(probe: Probe, account_id: str | None, variant: str | None = None) -> str:
    path = probe.path
    if "{account_id}" in path:
        path = path.replace("{account_id}", account_id or "{account_id}")
    if variant is not None:
        path = path.replace("{variant}", variant)
    return path


def described(probe: Probe, account_id: str | None) -> str:
    """The call as a reader should see it, which is the verb, the path and the query."""
    paths = [endpoint_of(probe, account_id, variant) for variant in (probe.variants or (None,))]
    query = "?" + urlencode(list(probe.query)) if probe.query else ""
    return " ".join(f"GET {path}{query}" for path in paths)


def collect(probe: Probe, binary: str, profile: str, account_id: str | None) -> dict[str, Any]:
    """Run one probe and record what came back, or why nothing did."""
    record: dict[str, Any] = {
        "signals": list(probe.signals),
        "tier": probe.tier,
        "label": probe.label,
        "endpoint": described(probe, account_id),
        "controls": list(probe.controls),
        "fields": list(probe.fields),
        "shape": probe.shape,
    }

    values: dict[str, Any] = {}
    statuses: list[str] = []
    details: list[str] = []
    truncated = False

    for variant in probe.variants or (None,):
        outcome = call(
            binary,
            endpoint_of(probe, account_id, variant),
            probe.query,
            probe.tier == "account",
            profile,
        )
        statuses.append(outcome.status)
        if outcome.detail is not None:
            details.append(outcome.detail if variant is None else f"{variant}: {outcome.detail}")
        if outcome.status != "observed":
            continue

        body = outcome.body
        if isinstance(body, Mapping) and any(marker in body for marker in PAGE_MARKERS):
            truncated = True
        try:
            kept = shallow(body) if probe.shape == "shallow" else project(body, probe.fields)
        except ProjectionError as problem:
            statuses[-1] = "error"
            details.append(str(problem) if variant is None else f"{variant}: {problem}")
            continue

        if variant is None:
            values = kept
        else:
            values[variant] = kept

    # One status for the probe, and the worst one wins: a probe that got half of what it asked for
    # has not observed what its requirement needs.
    for candidate in ("error", "denied", "observed"):
        if candidate in statuses:
            record["status"] = candidate
            break
    else:
        record["status"] = "error"

    if record["status"] == "observed":
        record["value"] = values
        if truncated:
            record["truncated"] = True
    if details:
        record["detail"] = " | ".join(details)[:900]
    return record


def skipped(probe: Probe, why: str) -> dict[str, Any]:
    """A probe whose tier was not run, recorded so its requirements can say what they need."""
    return {
        "signals": list(probe.signals),
        "tier": probe.tier,
        "label": probe.label,
        "endpoint": described(probe, None),
        "controls": list(probe.controls),
        "fields": list(probe.fields),
        "shape": probe.shape,
        "status": "skipped",
        "detail": why,
    }


def self_digest() -> str | None:
    """This script's own digest, so a file made by a modified copy can be told apart.

    Not a security claim — anybody running the script can write whatever file they like. It catches
    the ordinary case: a copy that has been edited, or one from a version of the app that asked for
    different fields, arriving months later and being read as though it were current.
    """
    try:
        return "sha256:" + hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    except OSError:
        return None


def build(tiers: Mapping[str, dict[str, Any]], probes: Sequence[dict[str, Any]], binary: str) -> dict[str, Any]:
    return {
        "schema": SCHEMA,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "script": {
            "name": Path(__file__).name,
            "version": SCRIPT_VERSION,
            "digest": self_digest(),
        },
        "cli": {"version": cli_version(binary)},
        "tiers": dict(tiers),
        "probes": list(probes),
        # Over the probe set alone, not the whole envelope: the envelope carries this digest, and a
        # document cannot contain a digest of itself. It is also the part that has to survive being
        # parsed, stored and read back, which is what the digest is for.
        "digest": digest(list(probes)),
        "deferred": [{"signal": signal, "reason": reason} for signal, reason in DEFERRED],
    }


# ---------------------------------------------------------------------------------------------
# The command line
# ---------------------------------------------------------------------------------------------


def parser() -> argparse.ArgumentParser:
    made = argparse.ArgumentParser(
        prog="collect-evidence.py",
        description="Collect read-only security evidence a Databricks App cannot read for itself.",
        epilog="Run --dry-run first. It prints every call and every field, and makes none of them.",
    )
    made.add_argument("--profile", help="CLI profile for the workspace tier (a workspace admin)")
    made.add_argument("--account-profile", help="CLI profile for the account tier (an account admin)")
    made.add_argument("--out", help="where to write the file (default: waf-evidence-<when>.json)")
    made.add_argument(
        "--dry-run",
        action="store_true",
        help="print the calls and the fields kept, then exit without calling anything",
    )
    made.add_argument("--cli", default="databricks", help="path to the Databricks CLI (default: databricks)")
    made.add_argument(
        "--manifest",
        action="store_true",
        help="print the probe table as JSON and exit, for tooling rather than for reading",
    )
    return made


def manifest() -> dict[str, Any]:
    """The probe table as data.

    Here so the app and its CI read the table rather than a transcription of it. The requirements
    page can name the calls an admin will be asked to make, and the repository can check the table
    against the catalogue — every requirement no install can reach is either probed or deferred —
    without either of them parsing Python.
    """
    return {
        "schema": SCHEMA,
        "version": SCRIPT_VERSION,
        "digest": self_digest(),
        "verb": VERB,
        "probes": [
            {
                "signals": list(probe.signals),
                "tier": probe.tier,
                "label": probe.label,
                "what": probe.what,
                "path": probe.path,
                "query": [list(pair) for pair in probe.query],
                "variants": list(probe.variants),
                "fields": list(probe.fields),
                "shape": probe.shape,
                "controls": list(probe.controls),
            }
            for probe in PROBES
        ],
        "deferred": [{"signal": signal, "reason": reason} for signal, reason in DEFERRED],
    }


def show_plan(binary: str, workspace: str | None, account: str | None) -> None:
    """What --dry-run prints: the whole approval surface, and nothing that needs the network."""
    print(f"{Path(__file__).name} version {SCRIPT_VERSION}, schema {SCHEMA}")
    print(f"digest {self_digest()}")
    print()
    print("Every request this script makes is a GET. There are no others in the file.")
    print()

    for tier, profile in (("workspace", workspace), ("account", account)):
        chosen = [probe for probe in PROBES if probe.tier == tier]
        if profile is None:
            print(f"{tier} tier: not selected. {len(chosen)} probes would be skipped.")
            print()
            continue

        print(f"{tier} tier, profile {profile}: {len(chosen)} probes")
        for probe in chosen:
            print(f"  {described(probe, '<account-id>')}")
            print(f"    for {', '.join(probe.controls)}")
            if probe.shape == "shallow":
                print("    keeps every scalar within two levels of the response, minus the etag")
            else:
                print(f"    keeps {', '.join(probe.fields)}")
        print()

    print("Not collected yet:")
    for signal, reason in DEFERRED:
        print(f"  {signal}")
        print(f"    {reason}")
    print()
    print(f"CLI: {cli_version(binary) or 'not found on PATH'}")


def main(argv: Sequence[str]) -> int:
    arguments = parser().parse_args(argv)
    workspace_profile = arguments.profile
    account_profile = arguments.account_profile

    # Before anything, including `--manifest` and `--dry-run`: an approver reading the plan should be
    # reading a plan this script would agree to carry out.
    problems = audit_table()
    if problems:
        print("This script will not run, because its own probe table asks for too much:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        print(
            "\nThis is a check the script makes on itself. If this copy has been edited, take a fresh "
            "one and compare the checksum against the one the app publishes.",
            file=sys.stderr,
        )
        return 2

    if arguments.manifest:
        print(json.dumps(manifest(), indent=2, sort_keys=True))
        return 0

    if workspace_profile is None and account_profile is None:
        parser().print_usage(sys.stderr)
        print(
            "\nName at least one profile. --profile collects what a workspace admin can read, "
            "--account-profile what an account admin can. Both is best; either is useful.",
            file=sys.stderr,
        )
        return 2

    if arguments.dry_run:
        show_plan(arguments.cli, workspace_profile, account_profile)
        return 0

    tiers: dict[str, dict[str, Any]] = {}
    probes: list[dict[str, Any]] = []
    collected = 0

    for tier, profile in (("workspace", workspace_profile), ("account", account_profile)):
        chosen = [probe for probe in PROBES if probe.tier == tier]

        if profile is None:
            other = "an account admin" if tier == "account" else "a workspace admin"
            why = (
                f"The {tier} tier was not run. These requirements need {other} to run this script "
                f"with --{'account-profile' if tier == 'account' else 'profile'}."
            )
            tiers[tier] = {"ran": False, "reason": why}
            probes.extend(skipped(probe, why) for probe in chosen)
            continue

        who = identity(arguments.cli, profile, tier == "account")
        tiers[tier] = {"ran": True, "identity": who}

        if who.get("error") is not None:
            why = f"The {tier} tier could not authenticate: {who['error']}"
            tiers[tier] = {"ran": False, "reason": why, "identity": who}
            probes.extend(skipped(probe, why) for probe in chosen)
            continue

        raw_account = who.get("account_id")
        account_id = None if raw_account is None else str(raw_account)
        print(f"{tier} tier as {who.get('username') or profile} against {who.get('host') or 'an unnamed host'}")
        for probe in chosen:
            record = collect(probe, arguments.cli, profile, account_id)
            probes.append(record)
            print(f"  {record['status']:<9} {probe.label}")
        collected += 1

    if collected == 0:
        print(
            "\nNo tier could authenticate, so there is nothing worth writing. Check the profile "
            "names against `databricks auth profiles` and try --dry-run to see the calls.",
            file=sys.stderr,
        )
        return 3

    envelope = build(tiers, probes, arguments.cli)
    stamp = envelope["generated_at"].replace(":", "").replace("-", "")
    destination = Path(arguments.out or f"waf-evidence-{stamp}.json")
    destination.write_text(json.dumps(envelope, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    counted: dict[str, int] = {}
    for record in probes:
        counted[record["status"]] = counted.get(record["status"], 0) + 1
    summary = ", ".join(f"{count} {status}" for status, count in sorted(counted.items()))

    print(f"\nWrote {destination} ({summary})")
    print(f"Probe set digest {envelope['digest']}")
    print("Nothing in this file is a credential. Read it before you send it.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
