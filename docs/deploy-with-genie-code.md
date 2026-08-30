---
title: Deploy with Genie Code
description: Deploy the Well-Architected Framework assessment app into the current workspace from a single notebook, driven by Genie Code.
permalink: /deploy-with-genie-code/
eyebrow: Get started
---

# Deploy with Genie Code

This guide is written for Genie Code. Point Genie Code at this page and ask it to deploy the
Well-Architected Framework assessment app into the workspace you are working in. It runs the whole
deployment from one notebook, using `%sh` cells for the parts that need a terminal.

A person kicks it off with something like:

> Open a notebook attached to a cluster that allows `%sh`, then tell Genie Code:
> *"Follow the Deploy with Genie Code guide to deploy the WAF assessment app into this workspace.
> Create each cell below and run them in order, and stop and show me the output if any cell fails."*

## What Genie Code can and cannot do here

Genie Code runs code inside the workspace and is good at generating and running the cells below.
It cannot, on its own, run the piece that actually installs and deploys the app: the app ships as a
Node build deployed through the Databricks CLI (`npm run lifecycle`), and neither Node nor the CLI
runs in an ordinary notebook cell. This guide works around that by driving those steps through
`%sh` shell cells on the cluster.

That is a deliberate trade. It is **not** the documented, supported install path. The supported path
runs from a laptop or a workspace web terminal and is described in [Install the App]({{ '/install/' | relative_url }}).
Staying inside the workspace buys convenience and costs support: it depends on the cluster allowing
shell access and reaching the internet. If a cell fails, read [If a step fails](#if-a-step-fails)
and fall back to the supported path.

## Before you start

Confirm all of the following, because each one is a hard requirement for the shell path:

- **A cluster that allows `%sh`.** Use a dedicated (single-user) cluster and attach the notebook to
  it. `%sh` is not available on serverless notebooks, and on shared clusters it runs as a
  non-privileged user, so the `apt-get` and home-directory writes below fail there. Single-user also
  matters because step 1 writes a short-lived token to the driver's home directory.
- **Outbound internet from that cluster.** The steps download from `deb.nodesource.com` (Node), from
  `raw.githubusercontent.com` and the GitHub release host (the Databricks CLI installer), and from the
  public npm registry (`npm ci`). If workspace or cluster egress is locked down, this path will not
  work; use the supported path instead.
- **Databricks Apps enabled** in the workspace.
- **You can create a Lakebase project, use a SQL warehouse, and deploy Apps and jobs.** The
  identity that runs the notebook is the identity every step below acts as.
- **You are a direct member of the assessor group.** This guide uses `admins` by default. Group
  membership must be direct: a group nested inside `admins` does not count.

## Tell Genie Code to run this

Create these as notebook cells and run them top to bottom. Each `%sh` cell is a fresh shell, so the
tools land on disk (a config file, a cloned repo, an installed CLI) rather than in shell variables
that would not survive between cells.

### 1. Authenticate the CLI from the notebook

The Databricks CLI reads `~/.databrickscfg`. Write a profile there from the notebook's own session,
so the CLI acts as you. Use a profile rather than environment variables on purpose: the app's
lifecycle wrapper removes the standard Databricks auth environment variables (including
`DATABRICKS_HOST`, `DATABRICKS_TOKEN`, and `DATABRICKS_CONFIG_PROFILE`) before it calls the CLI, so an
env-var token would be thrown away and only a named profile survives.

```python
# Python cell
ctx = dbutils.notebook.entry_point.getDbutils().notebook().getContext()
host = ctx.apiUrl().get()
token = ctx.apiToken().get()

import os
cfg = os.path.expanduser("~/.databrickscfg")
with open(cfg, "w") as f:
    f.write(f"[waf]\nhost = {host}\ntoken = {token}\n")
print("Wrote profile 'waf' for", host, "to", cfg)
```

The context token is tied to this notebook session and is short-lived. If a later step fails with an
authentication error, replace the token line with a personal access token (see
[If a step fails](#if-a-step-fails)).

### 2. Install Node 22, the Databricks CLI, and git

The app needs Node 22 or later and Databricks CLI 0.292.0 or later. Install both on the driver.

```bash
%sh
set -e
# Node 22 (NodeSource) and git
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs git
# Databricks CLI (latest), installs to /usr/local/bin/databricks
curl -fsSL https://raw.githubusercontent.com/databricks/setup-cli/main/install.sh | sh
node --version && npm --version && git --version && /usr/local/bin/databricks --version
```

### 3. Clone the app and install dependencies

```bash
%sh
set -e
cd /tmp
rm -rf databricks-waf
git clone --depth 1 https://github.com/databricks-solutions/databricks-waf.git
cd databricks-waf/app
npm ci
echo "Clone and npm ci complete."
```

### 4. Provision resources and write the bindings

This one cell creates the Lakebase database, picks a running SQL warehouse, and writes the customer
bindings file the bundle expects. It keeps its values in one shell so they flow from step to step.

```bash
%sh
set -e
export PATH="$PATH:/usr/local/bin"
cd /tmp/databricks-waf/app
PROFILE=waf

# --- Lakebase Autoscaling project (idempotent: ignore "already exists") ---
databricks postgres create-project databricks-waf \
  --json '{"spec": {"display_name": "Databricks WAF"}}' \
  --profile $PROFILE >/dev/null 2>&1 || echo "Lakebase project already exists, reusing it."

# Wait for the production branch to be READY
for i in $(seq 1 40); do
  STATE=$(databricks postgres list-branches projects/databricks-waf --profile $PROFILE -o json \
    | python3 -c "import sys,json;d=json.load(sys.stdin);xs=d if isinstance(d,list) else d.get('branches',[]);print((xs[0].get('status',{}) if xs else {}).get('current_state',''))" 2>/dev/null)
  [ "$STATE" = "READY" ] && break
  sleep 5
done
echo "Lakebase branch state: $STATE"

# Resolve the database resource id (a new project's is 'databricks-postgres')
DBID=$(databricks api get /api/2.0/postgres/projects/databricks-waf/branches/production/databases --profile $PROFILE \
  | python3 -c "import sys,json;d=json.load(sys.stdin);xs=d if isinstance(d,list) else d.get('databases',d);print(xs[0]['database_id'])")

# --- Pick a running SQL warehouse ---
WID=$(databricks warehouses list --profile $PROFILE -o json \
  | python3 -c "import sys,json;d=json.load(sys.stdin);ws=d if isinstance(d,list) else d.get('warehouses',[]);r=[w for w in ws if w.get('state')=='RUNNING'] or ws;print(r[0]['id'] if r else '')")
if [ -z "$WID" ]; then echo "No SQL warehouse found. Create or start one, then re-run this cell." && exit 1; fi

# --- Write the bindings the bundle reads ---
mkdir -p .databricks/bundle/customer
cat > .databricks/bundle/customer/variable-overrides.json <<EOF
{
  "sql_warehouse_id": "$WID",
  "postgres_branch": "projects/databricks-waf/branches/production",
  "postgres_database": "projects/databricks-waf/branches/production/databases/$DBID",
  "assessor_group": "admins"
}
EOF
echo "Wrote bindings:"
cat .databricks/bundle/customer/variable-overrides.json
```

Read the printed bindings before continuing. To use a dedicated assessor group instead of `admins`,
edit the `assessor_group` value (its members must be direct members).

### 5. Deploy

Run the three lifecycle steps in order: validate, preview the plan, then apply. The preview
(`install` without `--apply`) prints the plan for review; the apply performs it, starts the app, and
runs the post-deploy checks.

```bash
%sh
set -e
export PATH="$PATH:/usr/local/bin"
cd /tmp/databricks-waf/app
npm run lifecycle -- validate --profile waf --target customer
npm run lifecycle -- install  --profile waf --target customer
npm run lifecycle -- install  --profile waf --target customer --apply
```

If the apply exits with an error on its final check, do not read that as either success or a clean
failure. Run step 6, then see [If a step fails](#if-a-step-fails).

### 6. Verify

```bash
%sh
export PATH="$PATH:/usr/local/bin"
databricks apps get databricks-waf-assessment --profile waf -o json \
  | python3 -c "import sys,json;d=json.load(sys.stdin);a=d.get('app_status') or {};dep=(d.get('active_deployment') or {}).get('status') or {};print('app_status:',a.get('state'));print('deployment:',dep.get('state'),dep.get('message',''));print('scopes:',d.get('effective_user_api_scopes') or d.get('user_api_scopes'));print('url:',d.get('url'))"
```

A healthy result reports `app_status: RUNNING` and `deployment: SUCCEEDED`. Open the URL, go to
**Utilities → Diagnostics** and confirm Database, Audit trail, and Identity are answering, then
**Assess → Prepare assessment** to define and run the first assessment.

## If a step fails

- **`%sh` is not permitted / command not found.** The cluster does not allow shell access. Move the
  notebook to a dedicated (single-user) cluster, or use the supported path in [Install the App]({{ '/install/' | relative_url }}).
- **A download times out (Node, CLI, or `npm ci`).** The cluster cannot reach the internet. This path
  needs egress to `deb.nodesource.com`, `raw.githubusercontent.com`, the GitHub release host, and the
  npm registry. If egress is controlled, deploy from a laptop or web terminal instead.
- **Authentication error during deploy.** The session token from step 1 has expired or the deploy
  outlived it. Create a personal access token (User settings → Developer → Access tokens) and rewrite
  the profile, then re-run from step 4:

  ```bash
  %sh
  printf '[waf]\nhost = %s\ntoken = %s\n' "https://<your-workspace-host>" "<your-PAT>" > ~/.databrickscfg
  ```

- **The CLI cannot find the profile.** Steps 1 and the `%sh` cells must share a home directory. On a
  dedicated cluster both run as root and read `/root/.databrickscfg`. Confirm with `%sh echo $HOME`
  and `%sh cat ~/.databrickscfg | grep host`.
- **`install --apply` exits non-zero on its post-deploy check.** The wrapper runs a second plan after
  applying and fails if any managed resource still shows a pending change. Do not assume this is
  harmless. Run step 6: if `app_status` is `RUNNING`, the deployment is `SUCCEEDED`, and the effective
  scopes match what the app declares, the app is deployed and usable, and on a first install the
  remaining diffs are commonly just the app object and the scheduled job's permissions reconciling. If
  the plan reports changes to any other resource, or scopes are missing, treat it as a real failure and
  use the supported path in [Install the App]({{ '/install/' | relative_url }}), which is authoritative
  for a clean, repeatable install. See also [Detailed DAB lifecycle]({{ '/deployment-lifecycle/' | relative_url }}).
- **`No SQL warehouse found`.** Start or create a warehouse, then re-run step 4.

## The supported alternative

If any of the above is a persistent blocker, the reviewed, supported path does not depend on the
cluster at all: clone the repository to a laptop or a workspace web terminal that has Node 22 and the
Databricks CLI, then follow [Install the App]({{ '/install/' | relative_url }}). It uses the same
bindings file and the same `npm run lifecycle` commands as steps 4 and 5 here.
