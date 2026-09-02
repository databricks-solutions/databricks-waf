// Evaluation metadata for the controls this app measures automatically.
//
// The pillar YAML files are generated from the published documentation, so they carry
// what Databricks says: the title, the anchor, the principle it sits under. What they
// cannot carry is how *this app* decides whether a control passes — which signal it
// reads, what counts as a pass, which thresholds apply, and when the control does not
// apply at all. That is this project's judgement, and it lives here so it is
// reviewable as one document rather than scattered across seven generated files.
//
// Applied by scripts/enrich-catalogue.mjs, which is idempotent and has a --check mode
// so CI fails when the catalogue and this table disagree. The direction matters: this
// file is the source and the pillar files are the product, so editing a control's
// evaluation fields directly in the YAML will be reverted rather than silently kept.
//
// Threshold keys are the snake_case names the resolvers read, and the values match
// the defaults compiled into them. Duplication is the point: moving the number here
// makes it inspectable and tunable without a release, and a reader disagreeing with a
// band can see exactly which one to argue with.

/** The bands most coverage-style controls use: at or above pass, below partial fails. */
const bands = (pass, partial) => ({ pass_share: pass, partial_share: partial });

/**
 * The two-step form every per-cluster fix takes, with the field to change named in the comment.
 *
 * Read-then-write rather than `databricks clusters edit CLUSTER_ID SPARK_VERSION --flag`, which is
 * the shape the CLI documents and a trap: the edit endpoint replaces the configuration, so a flag
 * given on its own silently resets the fields it did not mention. A reader following the terse
 * version to fix a runtime version can lose the cluster's worker count, its policy and its tags,
 * and find out when the next run costs three times as much.
 *
 * One helper rather than five copies because the shape is the part that must not drift: if the
 * safe pattern changes, it changes for every cluster fix at once.
 */
const editCluster = (change) =>
  `databricks clusters get 1234-567890-abc123 > cluster.json   # ${change}\n` +
  'databricks clusters edit --json @cluster.json';

/** Editing a running cluster restarts it, which is worth saying before somebody does it at 09:00. */
const RESTARTS = 'Editing a running cluster restarts it, so the work on it stops. Apply this in a window where that is acceptable.';

/**
 * Turning on the audit tables, shared by the three requirements that read them.
 *
 * One object rather than three copies, and not only to avoid the duplication: the alias group only
 * shares a fix between its members when they agree on it exactly, so two hand-maintained copies
 * that drift by a word would silently leave the third requirement with no fix at all.
 */
const AUDIT_SYSTEM_TABLES = {
  summary: 'Enable audit system tables at account level and grant the assessing identity SELECT on them.',
  cli:
    'databricks metastores current                              # the metastore id\n' +
    'databricks system-schemas enable <metastore-id> access\n' +
    'databricks system-schemas enable <metastore-id> compute',
  sql: 'GRANT SELECT ON SCHEMA system.access TO `waf-assessor`;',
  doc_url: 'https://docs.databricks.com/aws/en/admin/system-tables/audit-logs',
  caveat:
    'Events start arriving from the point the schema is enabled, not retroactively, so the staleness this control ' +
    'measures takes a day to clear even once the fix is in. Enabling the schema is an account-admin action; the ' +
    'grant is a metastore-admin one.',
};

/**
 * Removes a classic-compute control from an all-serverless estate.
 *
 * Serverless exposes no cluster configuration to govern, so a policy or termination
 * finding against it is a finding about something that does not exist. Estate-scoped
 * rather than per-segment because it asks a question about the whole estate — whether
 * any classic compute ran at all — and a mixed estate must still be assessed on the
 * classic part.
 */
const NO_CLASSIC_COMPUTE = {
  signal: 'sql:estate.compute_profile',
  operator: 'eq',
  value: 0,
  outcome: 'not-applicable',
  reason:
    'This estate ran no classic compute in the window, so there are no clusters for this to govern. The ' +
    'control is excluded from scoring rather than failed: serverless compute is configured by the platform ' +
    'rather than by you, so there is nothing here to get wrong.',
  scope: 'estate',
};

export const ENRICHMENT = {
  // ---------------------------------------------------------------- cost optimisation
  'CO-01-01': {
    measurability: 'system-table',
    collector: 'sql:uc.census',
    severity: 'high',
    alias_group: 'open-table-formats',
    criteria:
      'At least 95% of tables that store a format use Delta or Iceberg. Views, metric views and foreign ' +
      'tables are out of the denominator — they have no storage format to choose. Below 70% fails; in ' +
      'between is partial, because a migration under way is a different state from one never started.',
    thresholds: bands(0.95, 0.7),
    remediation: {
      summary: 'Convert remaining Parquet, CSV and JSON tables to Delta so they gain transactions and statistics.',
      sql: 'CONVERT TO DELTA parquet.`s3://bucket/path`;',
      doc_url: 'https://docs.databricks.com/aws/en/delta/convert-to-delta',
    },
  },
  'CO-01-02': {
    measurability: 'system-table',
    collector: 'sql:cost.compute_mix',
    severity: 'medium',
    criteria:
      'Almost no scheduled work runs on all-purpose compute. All-purpose is billed at a higher rate and ' +
      'stays up between runs, so a job on it is paid for twice over.',
    thresholds: bands(0.98, 0.85),
    remediation: {
      summary: 'Move scheduled work off all-purpose clusters onto job compute or serverless jobs.',
      // Read-modify-write rather than a partial update, because `tasks` is an array: sending one
      // task replaces every task the job has. The reshaping in the middle is the update endpoint's
      // own shape — it takes the settings under `new_settings`, and `get` returns them under
      // `settings`.
      cli:
        "databricks jobs get 620112326920 | jq '{job_id, new_settings: .settings}' > job.json\n" +
        '# in job.json, drop existing_cluster_id from each task and give it a job_clusters entry\n' +
        'databricks jobs reset --json @job.json',
      doc_url: 'https://docs.databricks.com/aws/en/jobs/compute',
      caveat:
        'A task with no cluster at all runs on serverless, which is usually the cheaper answer again. Reach for ' +
        'a job cluster where the workload needs a specific runtime, an init script or an instance type.',
    },
  },
  'CO-01-04': {
    measurability: 'system-table',
    collector: 'sql:compute.clusters',
    severity: 'medium',
    criteria:
      'At least 90% of all-purpose clusters run DBR 14 or later. Older runtimes lack performance work that ' +
      'has since landed, so they cost more to do the same job.',
    thresholds: { ...bands(0.9, 0.6), min_runtime_major: 14 },
    applicability: { preconditions: [NO_CLASSIC_COMPUTE] },
    remediation: {
      summary: 'Upgrade clusters to the latest long-term-support runtime.',
      cli: editCluster('set spark_version to the current LTS release'),
      doc_url: 'https://docs.databricks.com/aws/en/release-notes/runtime/',
      caveat: RESTARTS,
    },
  },
  'CO-01-05': {
    measurability: 'system-table',
    collector: 'sql:compute.clusters',
    severity: 'low',
    criteria:
      'GPU compute exists only where a workload needs it. Reported rather than banded, because whether a ' +
      'given GPU cluster is justified cannot be read from its configuration.',
    applicability: { preconditions: [NO_CLASSIC_COMPUTE] },
    remediation: {
      summary: 'Confirm each GPU cluster serves a deep-learning workload, and move the rest to CPU compute.',
      // No command, and the reason is the control: whether a GPU is justified is a fact about the
      // workload, not about the configuration. A snippet here would be a guess at somebody else's
      // model training.
      by_hand:
        'The finding names the GPU clusters. For each one, ask the team that runs it whether the workload trains ' +
        'or serves a model on the GPU. Where it does not — the common case is a general ETL cluster that was ' +
        'copied from a machine-learning template — change node_type_id to the equivalent CPU instance and restart. ' +
        'Where it does, nothing needs doing: this control is reported rather than banded for exactly that reason.',
      doc_url: 'https://docs.databricks.com/aws/en/compute/gpu',
    },
  },
  // Was a question until the audit in ADR 0071 asked what would answer it. The question was whether a
  // warehouse is the path of least resistance for somebody who needs to run SQL; query history records
  // the path they took, which is stronger evidence than a policy document, so this reads it.
  //
  // Interactive statements only, and its own signal rather than the compute mix beside it. The mix
  // measures all-purpose *spend*, which includes the SQL inside a scheduled task running on a job
  // cluster — the right place for it. Marking an estate down for orchestrating well is the failure this
  // population avoids.
  'CO-01-03': {
    measurability: 'system-table',
    collector: 'sql:workload.sql_paths',
    severity: 'medium',
    criteria:
      'At least 90% of the statements a person submitted ran on a SQL warehouse rather than on an ' +
      'all-purpose cluster. Statements a job or pipeline submitted are outside the population: they say ' +
      'nothing about which path is easiest for a human, which is what the requirement is about.',
    thresholds: bands(0.9, 0.6),
    remediation: {
      summary:
        'Give the people running ad-hoc SQL a warehouse and take away the need to start a cluster for it.',
      cli:
        'databricks warehouses create --json \'{"name":"analyst-sql","warehouse_type":"PRO",' +
        '"cluster_size":"Small","enable_serverless_compute":true,"auto_stop_mins":10}\'\n' +
        '# then grant CAN_USE on it to the group that has been starting clusters instead',
      doc_url: 'https://docs.databricks.com/aws/en/compute/sql-warehouse/create',
      caveat:
        'Access is the half a warehouse does not fix. Somebody who cannot use a warehouse but can start a ' +
        'cluster will start a cluster, so check the entitlements and the cluster policy alongside — that is ' +
        'what makes one path easier than the other.',
    },
  },
  'CO-01-06': {
    measurability: 'system-table',
    collector: 'sql:cost.compute_mix',
    severity: 'high',
    alias_group: 'serverless-adoption',
    criteria:
      'At least 80% of compute spend runs on serverless. The partial band is wide because serverless ' +
      'migration is a programme of work rather than a setting, and partial adoption is real progress.',
    thresholds: bands(0.8, 0.3),
    remediation: {
      summary: 'Move eligible jobs, pipelines and warehouses to serverless compute.',
      // Three commands because the estate has three kinds of compute in it and the share this
      // control measures is spend across all of them. A warehouse is a flag; a job is the absence
      // of a cluster; a pipeline is a field.
      cli:
        'databricks warehouses edit abc123def456 --enable-serverless-compute\n' +
        'databricks pipelines update 0f1e2d3c --serverless\n' +
        '# a task with no cluster of its own runs serverless, so the fix for a job is a removal\n' +
        "databricks jobs get 620112326920 | jq '{job_id, new_settings: (.settings | del(.job_clusters) |" +
        " .tasks |= map(del(.job_cluster_key, .existing_cluster_id, .new_cluster)))}' > job.json\n" +
        'databricks jobs reset --json @job.json',
      doc_url: 'https://docs.databricks.com/aws/en/compute/serverless/',
      caveat:
        'Serverless does not take an init script, a custom container or a specific instance type. Where a workload ' +
        'depends on one of those, the honest answer is that it stays on classic compute, and this requirement is ' +
        'the one to accept rather than fix.',
    },
  },
  // Was a question until per-node CPU was checked: `node_timeline` records it directly, so whether
  // anyone tested a smaller size is a weaker thing to know than the answer the platform already
  // holds. Read only for its failure — a cluster idling near zero for the whole window — never for a
  // pass, because a busier reading does not prove a workload could not run smaller. `node_timeline`
  // has returned no row on every labs workspace probed for this, going back to the last classic
  // cluster that ran in the region in September 2024: an empty reading is reported as unmeasured
  // rather than as a pass. See resolvers/cluster-sizing.ts and app/config/statements/node_utilization.sql.
  'CO-01-08': {
    measurability: 'system-table',
    collector: 'sql:compute.node_utilization',
    severity: 'medium',
    criteria:
      'No cluster averages under 5% combined CPU across every sample it has for the window. A cluster ' +
      'that idles that low for the whole window has never used what it is given; a cluster above the ' +
      'threshold is not thereby shown to be right-sized, so the measure only ever fails an estate over ' +
      'the clusters it can show are idle, and reports unmeasured rather than a pass otherwise.',
    remediation: {
      summary: 'Reduce the worker count or instance size on a cluster idling near zero for the whole window.',
      cli: editCluster('reduce num_workers, or the node_type_id, to match the CPU it actually uses'),
      doc_url: 'https://docs.databricks.com/aws/en/compute/cluster-config-best-practices',
      caveat:
        'Confirm the window covered the workload’s normal running time before downsizing — a cluster idle because ' +
        'it caught a quiet week reads identically to one that is genuinely oversized, and the fix for one is a ' +
        'schedule change rather than a smaller instance.',
    },
  },
  'CO-01-10': {
    measurability: 'system-table',
    collector: 'sql:cost.compute_mix',
    severity: 'medium',
    alias_group: 'photon',
    criteria:
      'At least 70% of eligible spend runs on a vectorised engine. An estate almost entirely on serverless ' +
      'gets this by architecture, since Photon is not a setting there.',
    thresholds: { ...bands(0.7, 0.3), serverless_credit_share: 0.95 },
    remediation: {
      summary: 'Enable Photon on clusters running SQL and Delta workloads.',
      cli:
        'databricks warehouses edit abc123def456 --enable-photon\n' +
        'databricks pipelines update 0f1e2d3c --photon\n' +
        `${editCluster('set runtime_engine to PHOTON')}`,
      doc_url: 'https://docs.databricks.com/aws/en/compute/photon',
      caveat:
        'Photon bills at a higher DBU rate and earns it back by finishing sooner, which it does for SQL and Delta ' +
        'work and does not for a Python UDF that spends its time outside the engine. Compare the job’s cost before ' +
        'and after rather than assuming either direction.',
    },
  },
  'CO-02-01': {
    measurability: 'system-table',
    collector: 'sql:compute.clusters',
    severity: 'medium',
    alias_group: 'compute-autoscaling',
    criteria: 'At least 80% of all-purpose clusters autoscale rather than running at a fixed size.',
    thresholds: bands(0.8, 0.4),
    applicability: { preconditions: [NO_CLASSIC_COMPUTE] },
    remediation: {
      summary: 'Enable autoscaling with a sensible minimum on long-lived clusters.',
      // The policy as well as the cluster, because this control is measured across the fleet: fixing
      // the clusters that exist leaves the next one to be created fixed-size again.
      cli:
        `${editCluster('replace num_workers with autoscale: {min_workers, max_workers}')}\n` +
        'databricks cluster-policies create --name autoscaling-required \\\n' +
        '  --definition \'{"autoscale.min_workers": {"type": "range", "minValue": 1},' +
        ' "autoscale.max_workers": {"type": "range", "maxValue": 8}}\'',
      doc_url: 'https://docs.databricks.com/aws/en/compute/configure',
      caveat:
        'A minimum of one worker is not always right: a cluster serving interactive queries with a minimum of one ' +
        'will scale up while somebody waits. Set the minimum to the size the workload needs at rest.',
    },
  },
  'CO-02-02': {
    measurability: 'system-table',
    collector: 'sql:compute.clusters',
    severity: 'high',
    criteria:
      'Every all-purpose cluster terminates automatically. An idle cluster without it bills until someone ' +
      'notices, which is the most common avoidable cost in an estate.',
    thresholds: bands(1, 0.7),
    applicability: { preconditions: [NO_CLASSIC_COMPUTE] },
    remediation: {
      summary: 'Set auto-termination on every all-purpose cluster and enforce it through a policy.',
      cli:
        `${editCluster('set autotermination_minutes to 30')}\n` +
        'databricks cluster-policies create --name termination-required \\\n' +
        '  --definition \'{"autotermination_minutes": {"type": "range", "maxValue": 60, "defaultValue": 30}}\'',
      doc_url: 'https://docs.databricks.com/aws/en/compute/configure',
    },
  },
  'CO-02-03': {
    measurability: 'system-table',
    collector: 'sql:compute.clusters',
    severity: 'high',
    criteria:
      'At least 90% of clusters are created from a policy. Policies are what make the other compute ' +
      'controls hold over time instead of being re-fixed after every drift.',
    thresholds: bands(0.9, 0.5),
    applicability: { preconditions: [NO_CLASSIC_COMPUTE] },
    remediation: {
      summary: 'Define compute policies and restrict cluster creation to them.',
      // Creating the policy is the easy half. The half that changes the measurement is taking
      // unrestricted cluster creation away, which is a permission rather than a policy field.
      cli:
        'databricks cluster-policies create --name governed-all-purpose \\\n' +
        '  --definition \'{"autotermination_minutes": {"type": "range", "maxValue": 60, "defaultValue": 30},' +
        ' "custom_tags.cost_centre": {"type": "unlimited", "isOptional": false}}\'\n' +
        'databricks cluster-policies set-permissions <policy-id> \\\n' +
        '  --json \'{"access_control_list": [{"group_name": "data-engineers", "permission_level": "CAN_USE"}]}\'\n' +
        '# then take "Unrestricted cluster creation" off those groups in the account console',
      doc_url: 'https://docs.databricks.com/aws/en/admin/clusters/policies',
      caveat:
        'Clusters created before the policy keep their configuration: a policy constrains new clusters and edits, ' +
        'not existing ones. Both halves of this finding stay until the fleet is recreated or edited.',
    },
  },
  'CO-03-01': {
    measurability: 'system-table',
    collector: 'sql:cost.attribution',
    severity: 'high',
    criteria:
      'At least 80% of spend carries a custom tag attributing it to a team or workload. Untagged spend has ' +
      "no owner, which is what makes it nobody's to reduce.",
    thresholds: bands(0.8, 0.3),
    remediation: {
      summary: 'Require cost-centre tags through compute policies, and budget policies for serverless spend.',
      // `isOptional: false` on a tag key is the whole mechanism: it makes the cluster form refuse to
      // submit without a value, which is why tagging through policy sticks and tagging by convention
      // does not.
      cli:
        'databricks cluster-policies create --name cost-attributed \\\n' +
        '  --definition \'{"custom_tags.cost_centre": {"type": "unlimited", "isOptional": false},' +
        ' "custom_tags.owner": {"type": "unlimited", "isOptional": false}}\'',
      doc_url: 'https://docs.databricks.com/aws/en/admin/account-settings/usage-detail-tags',
      caveat:
        'Serverless spend carries no cluster tags, because there is no cluster to tag. It is attributed through a ' +
        'budget policy in the account console instead, and an estate mostly on serverless will not close this ' +
        'finding with compute policies alone.',
    },
  },
  'CO-04-01': {
    measurability: 'system-table',
    collector: 'sql:jobs.inventory',
    severity: 'medium',
    criteria:
      'Streaming jobs that do not need continuous processing use triggered execution. A continuous stream ' +
      'holds compute permanently, so a job whose data arrives hourly pays for 24 hours of readiness.',
    thresholds: { max_continuous_share: 0.25 },
    remediation: {
      summary: 'Switch streams with relaxed latency requirements to AvailableNow triggers.',
      // A code change, so there is no command. Named precisely enough to find in a notebook: the
      // two calls are one line apart and the second is the fix.
      by_hand:
        'In the streaming query, replace .trigger(processingTime="...") or .trigger(continuous=...) with ' +
        '.trigger(availableNow=True), and give the job a schedule at the interval the data actually arrives on. ' +
        'The stream keeps its checkpoint, so it resumes where the continuous version stopped rather than reprocessing. ' +
        'Leave the streams where a consumer is waiting on sub-minute latency: this control asks which ones are not.',
      doc_url: 'https://docs.databricks.com/aws/en/structured-streaming/triggers',
    },
  },
  'CO-04-02': {
    measurability: 'system-table',
    collector: 'sql:compute.clusters',
    severity: 'low',
    criteria:
      'Spot capacity is used where interruption is tolerable. The band is low deliberately: spot is wrong ' +
      'for latency-critical work, so a low figure is not automatically a failure.',
    thresholds: bands(0.5, 0.2),
    applicability: { preconditions: [NO_CLASSIC_COMPUTE] },
    remediation: {
      summary: 'Use spot instances for fault-tolerant batch work, keeping the driver on-demand.',
      cli: editCluster('set aws_attributes.availability to SPOT_WITH_FALLBACK, first_on_demand to 1'),
      doc_url: 'https://docs.databricks.com/aws/en/compute/cluster-config-best-practices',
      caveat:
        'first_on_demand: 1 keeps the driver on guaranteed capacity, which is the difference between losing a worker ' +
        'and losing the run. On Azure the equivalent fields are azure_attributes.availability and ' +
        'spot_bid_max_price; on GCP, gcp_attributes.use_preemptible_executors.',
    },
  },

  // -------------------------------------------------------- data and AI governance
  'DG-01-02': {
    measurability: 'system-table',
    collector: 'sql:uc.census',
    severity: 'critical',
    alias_group: 'unity-catalog-governed',
    criteria:
      'The tables, catalogs and schemas this Unity Catalog metastore holds. The census cannot see a ' +
      'legacy metastore, so the finding is a count of what is governed and not a share of an estate — a ' +
      'pass says how many, and does not claim that it is everything.',
    remediation: {
      summary: 'Migrate remaining Hive metastore tables to Unity Catalog.',
      // DRY RUN first, always. SYNC reports per table what it would do and why it would refuse —
      // an unsupported format, a location already claimed — and running it blind on a schema of a
      // few hundred tables produces a wall of errors with no order to work through them in.
      sql:
        'SYNC SCHEMA main.sales FROM hive_metastore.sales DRY RUN;\n' +
        'SYNC SCHEMA main.sales FROM hive_metastore.sales SET OWNER `data-platform`;',
      doc_url: 'https://docs.databricks.com/aws/en/data-governance/unity-catalog/migrate',
      caveat:
        'SYNC upgrades external tables in place, leaving the data where it is and pointing Unity Catalog at it. A ' +
        'managed Hive table has to be copied instead, with CREATE TABLE ... AS SELECT, because its storage belongs ' +
        'to the old metastore.',
    },
  },
  'DG-01-03': {
    measurability: 'system-table',
    collector: 'sql:uc.census',
    severity: 'critical',
    alias_group: 'unity-catalog-governed',
    criteria:
      'Same measurement as DG-01-02, read as the single-place-for-metadata requirement. Scored once through ' +
      'the alias group. The count is of what this metastore holds, not of whether anything sits beside it.',
  },
  'DG-01-04': {
    measurability: 'system-table',
    collector: 'sql:uc.lineage_coverage',
    severity: 'medium',
    criteria:
      'At least half of tables appear in lineage. Lineage is emitted by activity, so a table nothing read ' +
      'or wrote in the window is absent for a reason that is not a governance gap — which is why this band ' +
      'is far below the others.',
    thresholds: bands(0.5, 0.15),
    remediation: {
      summary: 'Run workloads through Unity Catalog-enabled compute so lineage is captured automatically.',
      // Nothing to switch on: lineage is emitted by the compute, or it is not emitted. The fix is
      // the access mode, which is why this reads like the Unity Catalog cluster finding — it is the
      // same field, asked for a different reason.
      cli: editCluster('set data_security_mode to USER_ISOLATION'),
      doc_url: 'https://docs.databricks.com/aws/en/data-governance/unity-catalog/data-lineage',
      caveat:
        'Lineage follows activity, so a table nothing has read or written in the window stays absent even after the ' +
        'compute is fixed. The share this control measures moves as the next runs happen, not when the cluster is ' +
        'edited. Serverless and SQL warehouses already emit it.',
    },
  },
  'DG-01-05': {
    measurability: 'system-table',
    collector: 'sql:uc.census',
    severity: 'low',
    criteria:
      'At least 80% of tables carry a description. The failure worth catching is an estate with almost ' +
      'none, so the partial band reaches down to 40%.',
    thresholds: bands(0.8, 0.4),
    remediation: {
      summary: 'Add comments to tables and columns, or generate them with AI-suggested documentation.',
      sql:
        "COMMENT ON TABLE main.sales.orders IS 'One row per placed order, from the checkout service.';\n" +
        "ALTER TABLE main.sales.orders ALTER COLUMN order_id COMMENT 'Checkout service order id.';",
      doc_url: 'https://docs.databricks.com/aws/en/comments/',
      caveat:
        'Catalog Explorer will suggest a description for a table from its schema and sample data, which is faster ' +
        'than writing several hundred by hand and worth reading before accepting: a generated comment describing ' +
        'what a column contains is useful, and one guessing why it exists is not.',
    },
  },
  /*
   * DG-01-06, converted from a question by 37k.
   *
   * The same share DG-01-05 takes, over the tables lineage says something read. Two numbers
   * that answer different questions: on labs, 4 of 19 tables carry a description and none of
   * the 9 that anything read did. An estate can document its long tail and leave the assets
   * people actually reach for blank, and only the narrower population catches that.
   *
   * Banded identically to DG-01-05 on purpose, so the two shares are read against the same
   * ruler and the difference between them is the finding rather than an artefact of the bands.
   * Tags, owners and column comments are collected and reported beside the score without
   * entering it: each is part of being findable, and nothing measured here says how to weigh
   * three shares against one another.
   */
  /*
   * DG-03-02, converted from a question by 37j.
   *
   * The quality monitor is readable estate-wide where an account admin has enabled the
   * schema. `78` measured both bands a resolver might have taken and ruled them out:
   * estate coverage is 2.8% on large-estate (platform adoption), and the health share of
   * monitored tables is 98.6% Healthy with one Unhealthy (moves for nobody). Labs has
   * no such schema, so there is nowhere to calibrate a threshold. ADR 0102: report the
   * counts, do not band, hand on-failure behaviour to a person.
   */
  'DG-03-02': {
    measurability: 'system-table',
    collector: 'sql:uc.quality_monitoring',
    severity: 'medium',
    criteria:
      'The latest quality-monitor verdict per customer table is counted and reported. It is not scored: ' +
      'estate coverage measures whether the monitor was turned on, and a Healthy share of the tables it ' +
      'already watches is what the monitor is for. What happens on failure — expect, expect_or_drop, ' +
      'expect_or_fail — is not in this signal, so the requirement stays a question after the reading.',
    remediation: {
      summary:
        'Declare pipeline expectations with an action on violation — expect_or_fail or expect_or_drop — so a ' +
        'bad row stops or is quarantined rather than being logged and published.',
      by_hand:
        'Open the pipeline that writes a published table, and on each expectation set expect_or_fail for an ' +
        'invariant that must hold or expect_or_drop for rows that can be discarded. A bare expect only logs. ' +
        'This scan cannot read that action — it is not in table_results — so the finding names the monitor ' +
        'counts and still asks what happens on failure. Enabling the quality monitor is not the remedy.',
      doc_url: 'https://docs.databricks.com/aws/en/ldp/expectations',
      caveat:
        'This reading does not fail. The counts it reports are not a shortfall, and a Healthy verdict is not ' +
        'evidence a pipeline stops a violating row.',
    },
  },

  'DG-01-06': {
    measurability: 'system-table',
    collector: 'sql:uc.discovery',
    severity: 'medium',
    criteria:
      'At least 80% of the tables that appear as a read in lineage over the window carry a description — ' +
      'the same band as DG-01-05, over the assets consumers reach for rather than the whole estate. Tags, ' +
      'owners and column comments are reported alongside and do not enter the band. An estate nothing read ' +
      'in the window is unmeasured rather than failed: there is no population to take the share over.',
    thresholds: bands(0.8, 0.4),
    remediation: {
      summary:
        'Describe the tables consumers actually read first — the finding names how many there are, and it ' +
        'is a far shorter list than the estate.',
      sql:
        "COMMENT ON TABLE main.sales.orders IS 'One row per placed order, from the checkout service.';\n" +
        "ALTER TABLE main.sales.orders SET TAGS ('domain' = 'sales');",
      doc_url: 'https://docs.databricks.com/aws/en/discover/',
      caveat:
        'A consumer who searched, could not tell what an asset held and gave up reads nothing, so they leave ' +
        'no lineage and are not in the population this measures. Describing the read tables raises this share ' +
        'without reaching them, which is the argument for DG-01-05 as well as this one.',
    },
  },
  'DG-01-07': {
    measurability: 'system-table',
    collector: 'sql:uc.census',
    severity: 'medium',
    criteria:
      'AI assets — models, functions, volumes — are registered in Unity Catalog alongside data rather than ' +
      'governed separately or not at all.',
    remediation: {
      summary: 'Register models in Unity Catalog and grant on them the same way as on tables.',
      // The grant is SQL because a registered model is a securable like any other, which is the
      // point of the requirement. Getting it registered in the first place is a one-line change in
      // the training run, named in the caveat because it is not something to run in an editor.
      sql:
        'GRANT EXECUTE ON MODEL main.ml.churn TO `ml-consumers`;\n' +
        'GRANT READ VOLUME ON VOLUME main.ml.features TO `ml-consumers`;',
      doc_url: 'https://docs.databricks.com/aws/en/machine-learning/manage-model-lifecycle/',
      caveat:
        'A model reaches the catalogue from the training run: set the MLflow registry URI to databricks-uc and ' +
        'register under a three-level name. Models left in the workspace registry cannot be granted on, which is ' +
        'what this requirement is asking about.',
    },
  },
  'DG-02-02': {
    measurability: 'system-table',
    collector: 'sql:governance.audit_coverage',
    severity: 'high',
    alias_group: 'audit-logging',
    criteria:
      'Audit events are being written and are no more than two days stale. A gap here is not only a ' +
      'governance failure; it removes the evidence any later investigation would depend on.',
    thresholds: { max_days_since_event: 2 },
    remediation: AUDIT_SYSTEM_TABLES,
  },
  'DG-02-03': {
    measurability: 'system-table',
    collector: 'sql:governance.audit_coverage',
    severity: 'high',
    alias_group: 'audit-logging',
    criteria:
      'Same measurement as DG-02-02, read as the platform-events requirement. Scored once through the alias ' +
      'group: one audit configuration satisfies both.',
    thresholds: { max_days_since_event: 2 },
  },
  'DG-03-03': {
    measurability: 'system-table',
    collector: 'sql:uc.census',
    severity: 'high',
    alias_group: 'open-table-formats',
    criteria: 'Same requirement as CO-01-01, read from the governance side. Scored once through the alias group.',
    thresholds: bands(0.95, 0.7),
  },

  // ------------------------------------------------------------ performance efficiency
  'PE-02-01': {
    measurability: 'system-table',
    collector: 'sql:cost.compute_mix',
    severity: 'high',
    alias_group: 'serverless-adoption',
    criteria: 'Same requirement as CO-01-06, read from the performance side. Scored once through the alias group.',
    thresholds: bands(0.8, 0.3),
  },
  'PE-03-05': {
    measurability: 'system-table',
    collector: 'describe:predictive_optimization.coverage',
    severity: 'medium',
    criteria:
      'Predictive optimization is enabled across managed tables, so layout maintenance happens without ' +
      'anyone scheduling it. Where it is on, absent manual maintenance is correct rather than a finding.',
    thresholds: bands(1, 0.5),
    remediation: {
      summary: 'Enable predictive optimization at catalog level so new schemas inherit it.',
      sql: 'ALTER CATALOG main ENABLE PREDICTIVE OPTIMIZATION;',
      doc_url: 'https://docs.databricks.com/aws/en/optimizations/predictive-optimization',
    },
  },
  'PE-03-06': {
    measurability: 'system-table',
    collector: 'sql:uc.census',
    severity: 'medium',
    criteria:
      'At least 80% of tables are managed, so the platform can maintain them. External tables put layout, ' +
      'compaction and cleanup back on you.',
    thresholds: bands(0.8, 0.4),
    remediation: {
      summary: 'Prefer managed tables for new data, and convert external tables where the location is not required.',
      // Deliberately the same mechanism as OE-02-03 and stated for a different reason: there it is
      // about who owns the layout, here about who maintains it. Both are true and the SQL is the
      // same shape, so the difference is which one the reader is being told to care about.
      sql:
        'CREATE TABLE main.sales.orders AS SELECT * FROM main.sales.orders_external;\n' +
        'ALTER CATALOG main ENABLE PREDICTIVE OPTIMIZATION;',
      doc_url: 'https://docs.databricks.com/aws/en/tables/managed',
      caveat:
        'Being managed is what lets the platform compact, cluster and vacuum a table without being asked, which is ' +
        'why this is a performance requirement and not only a governance one. An external table gets none of that ' +
        'until somebody schedules it.',
    },
  },
  'PE-03-08': {
    measurability: 'system-table',
    collector: 'sql:cost.compute_mix',
    severity: 'medium',
    alias_group: 'photon',
    criteria: 'Same requirement as CO-01-10, read from the performance side. Scored once through the alias group.',
    thresholds: { ...bands(0.7, 0.3), serverless_credit_share: 0.95 },
  },
  // Also a question until ADR 0071, and the reading it needed is on every statement: how much of what
  // was read came from cache. Weighted by bytes rather than by statement, because the column is a
  // per-statement percentage and averaging it gives a metadata lookup the same weight as a scan of a
  // terabyte.
  //
  // Caps at nothing and asks nothing further, with one caveat carried in the finding: the disk cache is
  // on by default on most compute, so a good share is not proof anybody chose it. A poor share on a
  // workload that reads the same data repeatedly is the finding worth having, and that is the direction
  // this measures in.
  'PE-03-10': {
    measurability: 'system-table',
    collector: 'sql:workload.sql_paths',
    severity: 'medium',
    criteria:
      'At least half the bytes read from files came from cache. The denominator is the statements that ' +
      'read a file at all: on the workspace this was measured against, 3,621 of 5,885 statements read ' +
      'nothing — answered from metadata or from memory — and a hit rate computed over those describes the ' +
      'workload rather than the cache. Result-cache hits are reported separately rather than counted as ' +
      'a miss, because a statement answered from them never reached the cache below.',
    thresholds: bands(0.5, 0.2),
    remediation: {
      summary:
        'Find the repeated reads that are missing the cache, and give them compute that can hold the data.',
      sql:
        '-- Where the misses are, over the statements that read files\n' +
        'SELECT compute.warehouse_id, count(*) AS statements,\n' +
        '       round(sum(read_bytes * coalesce(read_io_cache_percent, 0) / 100.0) / sum(read_bytes) * 100, 1)\n' +
        '         AS cached_percent\n' +
        'FROM system.query.history\n' +
        "WHERE start_time >= current_date() - INTERVAL 7 DAYS AND read_files > 0\n" +
        'GROUP BY 1 ORDER BY statements DESC;',
      doc_url: 'https://docs.databricks.com/aws/en/optimizations/disk-cache',
      caveat:
        'A low share is not always wrong. A workload that reads each row once has nothing to re-read, and ' +
        'the cache cannot help it — read this against what the queries do rather than as a target to hit.',
    },
  },
  'PE-03-11': {
    measurability: 'system-table',
    collector: 'describe:storage.table_details',
    severity: 'medium',
    coverage_mode: 'sampled',
    criteria:
      'Files average at least 16 MiB on tables large enough to hold one, whether kept that way by ' +
      'predictive optimization or by scheduled OPTIMIZE. The file size decides it rather than whether the ' +
      'command ran, because running OPTIMIZE and still holding tiny files is not a pass. Tables smaller ' +
      'than one target file are excluded rather than counted as failures: they cannot reach the target ' +
      'however they are written, and a control that says otherwise asks for work that cannot be done.',
    thresholds: { min_average_file_bytes: 16777216 },
    remediation: {
      summary: 'Enable predictive optimization, or schedule OPTIMIZE on the tables queried most.',
      sql: 'OPTIMIZE main.default.events;',
      doc_url: 'https://docs.databricks.com/aws/en/delta/optimize',
    },
  },
  'PE-03-12': {
    measurability: 'system-table',
    collector: 'describe:storage.table_details',
    severity: 'medium',
    coverage_mode: 'sampled',
    criteria:
      'No table disables file statistics, which turns skipping off outright, and tables large enough for ' +
      'skipping to change what a query reads organise their files by liquid clustering, automatic ' +
      'clustering or partitioning. Whether skipping is effective is not tested: that depends on the ' +
      'predicates queries use, which this scan does not read against table layout. So this measures ' +
      'whether skipping is possible, and says so.',
    thresholds: {
      min_bytes_for_skipping: 1073741824,
      min_files_for_skipping: 10,
      ...bands(0.8, 0.4),
    },
    remediation: {
      summary:
        'Set liquid clustering on the largest actively read tables, and leave ' +
        'delta.dataSkippingNumIndexedCols at its default of 32.',
      sql: 'ALTER TABLE catalog.schema.table CLUSTER BY (order_date);',
      doc_url: 'https://docs.databricks.com/aws/en/delta/data-skipping',
      caveat:
        'Restoring the statistics property does not backfill statistics for files already written; those ' +
        'are collected when each file is next rewritten. Clustering an existing table rewrites data, so it ' +
        'costs compute once.',
    },
  },
  'PE-03-13': {
    measurability: 'system-table',
    collector: 'describe:storage.table_details',
    severity: 'medium',
    coverage_mode: 'sampled',
    criteria:
      'No table holding data below the size floor is partitioned. The floor is the WAF\u2019s own published ' +
      'number, and liquid clustering counts in a table\u2019s favour because the same page recommends it in ' +
      'preference to partitioning. A partitioned table holding nothing is excluded rather than failed: it has ' +
      'no partitions of any size, so how finely it is partitioned is not a question about reads. The companion ' +
      'rule \u2014 each partition holding at least 1GB \u2014 is not tested, because it needs partition ' +
      'cardinality that the per-table describe does not return.',
    thresholds: { min_bytes_before_partitioning: 1099511627776 },
    remediation: {
      summary:
        'Drop partitioning on tables below 1TB and use liquid clustering instead, which adapts as access ' +
        'patterns change.',
      sql: 'ALTER TABLE catalog.schema.table CLUSTER BY (event_date);',
      doc_url: 'https://docs.databricks.com/aws/en/delta/clustering',
      caveat:
        'Removing partitioning rewrites the table layout, so schedule it like any other rewrite. Liquid ' +
        'clustering and partitioning are mutually exclusive on the same table.',
    },
  },
  'PE-03-15': {
    measurability: 'system-table',
    collector: 'sql:maintenance.recency',
    severity: 'low',
    criteria:
      'Statistics are refreshed, so the optimiser plans against the data as it is rather than as it was. ' +
      'Predictive optimization covers this on managed tables.',
    remediation: {
      summary: 'Run ANALYZE TABLE on large tables, or rely on predictive optimization for managed ones.',
      sql: 'ANALYZE TABLE main.default.events COMPUTE STATISTICS FOR ALL COLUMNS;',
      doc_url: 'https://docs.databricks.com/aws/en/sql/language-manual/sql-ref-syntax-aux-analyze-table',
    },
  },
  // PE-03-16 (deletion vectors) is an extension control, so its evaluation fields live in
  // performance-efficiency.yaml alongside its rationale rather than here. The enrichment
  // table covers the generated waf-docs controls, whose YAML is rewritten from the
  // published documentation and cannot hold this project's judgement.

  // -------------------------------------------------------------------- reliability
  'REL-01-01': {
    measurability: 'system-table',
    collector: 'sql:uc.census',
    severity: 'high',
    alias_group: 'open-table-formats',
    criteria: 'Same requirement as CO-01-01, read from the reliability side. Scored once through the alias group.',
    thresholds: bands(0.95, 0.7),
  },
  // Was a question until `worker_count`, `min_autoscale_workers` and `max_autoscale_workers` were
  // checked: a single-node cluster is directly readable as all three at zero, and `cluster_source`
  // already separates job and pipeline compute from the interactive kind. See resolvers/cluster-sizing.ts.
  'REL-01-02': {
    measurability: 'system-table',
    collector: 'sql:compute.clusters',
    severity: 'high',
    criteria:
      'Every job or pipeline cluster runs with a fixed worker count above zero or an autoscale range ' +
      'starting above zero. A single-node cluster has no worker to fail over to, so losing its one node ' +
      'stops the run rather than degrading it. All-purpose clusters used interactively are out of scope.',
    thresholds: bands(1, 0.9),
    applicability: { preconditions: [NO_CLASSIC_COMPUTE] },
    remediation: {
      summary: 'Give the cluster at least one worker, or an autoscale floor above zero.',
      cli: editCluster('replace num_workers: 0 (or an all-zero autoscale range) with a fixed count or a floor above zero'),
      doc_url: 'https://docs.databricks.com/aws/en/compute/single-node',
      caveat:
        'Single-node is a deliberate choice for some workloads — a driver-only ML training job, a small batch ' +
        'that never benefits from a second executor — and moving one of those to multi-node adds idle worker cost ' +
        'for no resilience it needed. This flags dependence on one machine; whether that machine is production is ' +
        'still worth confirming before changing it.',
    },
  },
  'REL-01-04': {
    measurability: 'system-table',
    collector: 'sql:jobs.inventory',
    severity: 'high',
    criteria:
      'At least 80% of jobs with a recorded timeout setting carry a timeout above zero. Without one a hung run ' +
      'bills until someone notices missing data, which is the slowest detection available. Jobs whose timeout is ' +
      'not recorded in the system table are excluded from the share rather than counted as failures.',
    thresholds: bands(0.8, 0.4),
    remediation: {
      summary: 'Set a timeout, retries and an on-failure notification on each scheduled job.',
      // The timeout is the job-level field this control reads. Retries are per task, which is why
      // they are in the caveat rather than in the same body — a reader who pastes max_retries at
      // job level gets a rejected request and no explanation.
      cli:
        'databricks jobs update 620112326920 \\\n' +
        '  --json \'{"new_settings": {"timeout_seconds": 7200, "health": {"rules": [{"metric": ' +
        '"RUN_DURATION_SECONDS", "op": "GREATER_THAN", "value": 5400}]}}}\'',
      doc_url: 'https://docs.databricks.com/aws/en/jobs/settings',
      caveat:
        'Retries are a task setting, not a job one: max_retries and min_retry_interval_millis go inside each task. ' +
        'Retrying a task that is not idempotent turns one failure into two partial writes, so set them where a rerun ' +
        'is safe and leave them at zero where it is not.',
    },
  },
  'REL-01-06': {
    measurability: 'system-table',
    collector: 'sql:cost.compute_mix',
    severity: 'high',
    alias_group: 'serverless-adoption',
    criteria: 'Same requirement as CO-01-06, read from the reliability side. Scored once through the alias group.',
    thresholds: bands(0.8, 0.3),
  },
  // Was a question until ADR 0071 asked what would answer it. A Delta CHECK constraint is recorded
  // per table as a `delta.constraints.*` property, which the per-table describe already reads, so
  // whether one is declared is a reading rather than a judgement. Sampled, not estate-wide: the
  // describe runs on the most-read tables, so a pass is a pass over that sample and the finding says
  // so. There is no failure band — the only settled verdict is presence, because pipeline expectations
  // and NOT NULL rules enforce the same way and are not in this signal, so absence goes to a person
  // through the inconclusive question rather than scoring as a fail. `information_schema` is not the
  // source: `check_constraints` publishes columns and no rows, and `table_constraints` holds only the
  // informational keys Unity Catalog never enforces.
  'REL-02-04': {
    measurability: 'system-table',
    collector: 'describe:storage.table_details',
    severity: 'medium',
    coverage_mode: 'sampled',
    criteria:
      'A share of the sampled tables declare a Delta CHECK constraint, read from the `delta.constraints.*` ' +
      'properties rather than from the information schema. Presence is the only verdict this settles: a strong ' +
      'share passes, a smaller share is partial, and none is unmeasured rather than failed, because a table ' +
      'may enforce its rules through a pipeline expectation or a column NOT NULL that this signal does not ' +
      'carry. Primary and foreign keys do not count — Unity Catalog records them without enforcing them.',
    thresholds: { pass_share: 0.8 },
    remediation: {
      summary:
        'Declare CHECK constraints on the columns consumers depend on, so a violating write fails at the write ' +
        'rather than propagating; declare pipeline expectations for row-level rules, with an action on violation.',
      sql: 'ALTER TABLE catalog.schema.table ADD CONSTRAINT amount_positive CHECK (amount > 0);',
      doc_url: 'https://docs.databricks.com/aws/en/tables/constraints',
      caveat:
        'A CHECK constraint is validated against existing rows when it is added, so adding one to a table that ' +
        'already violates it fails until the data is corrected. Pipeline expectations and column NOT NULL rules ' +
        'enforce the same way and are not read here, so a table this reports without a CHECK constraint may ' +
        'still be enforcing its rules elsewhere.',
    },
  },
  /*
   * Four security-guide controls re-sourced from the system tables.
   *
   * These are in this table rather than in IMPLEMENTED_DELEGATED because the table owns the
   * collector and the criteria, and for these four both change. The guide answers each from a
   * control-plane endpoint no install of this app can call (ADR 0016); the app answers them from
   * `system.compute.clusters`, which it already reads, or — for the audit one — from a
   * measurement it already makes. So the criteria have to describe the measurement actually
   * taken, including the cases where the system table declines to answer, rather than the
   * endpoint the guide had in mind.
   */
  // Was a question until the audit log's authentication path was measured: a username-and-password
  // login is its own `action_name`, distinct from SAML and OAuth. Presence settles a failure; absence
  // does not settle a pass — see server/attest/inconclusive-questions.ts.
  'SCP-01-01': {
    measurability: 'system-table',
    collector: 'sql:security.auth_login_paths',
    severity: 'medium',
    criteria:
      'Username-and-password logins (`action_name = login`) in the audit window fail the control. Their ' +
      'absence is unmeasured rather than a pass: a local account that did not authenticate in the retained ' +
      'window looks exactly like no local account, and the account-plane provisioning path is unreadable. ' +
      'SAML (`samlLogin`) and OAuth (`oidcTokenAuthorization`) counts are reported beside the reading.',
    remediation: {
      summary:
        'Remove local username-and-password accounts and require SSO (or OAuth) for every human login.',
      by_hand:
        'In the account console, open User management and find any user that can sign in with a password ' +
        'rather than through your identity provider. Disable or delete those accounts, and confirm SSO ' +
        '(or OIDC) is the only path left for humans. The audit reading only names credentials that were ' +
        'used in the window — accounts that exist but never logged in are invisible to it.',
      doc_url:
        'https://docs.databricks.com/aws/en/lakehouse-architecture/security-compliance-and-privacy/best-practices#account-setup-and-identity-configuration',
      caveat:
        'This reading identifies local credentials that were used. Accounts that exist but never logged in ' +
        'during the window are invisible here, and the account console that would list them is out of scope.',
    },
  },
  'SCP-04-04': {
    measurability: 'system-table',
    collector: 'sql:compute.clusters',
    severity: 'high',
    criteria:
      'No all-purpose cluster runs a Databricks Runtime below the oldest supported major version. Distinct ' +
      'from CO-01-04, which asks whether runtimes are current: this asks whether any is unsupported, and an ' +
      'unsupported runtime stops receiving security patches, so a vulnerability in it stays open. A runtime ' +
      'string that cannot be parsed counts as unsupported.',
    // The support floor, which moves roughly annually. Here rather than in the resolver so it can
    // be raised without a code change when the next long-term-support release ages out.
    thresholds: { min_supported_runtime_major: 14, pass_share: 1, partial_share: 0.9 },
    applicability: { preconditions: [NO_CLASSIC_COMPUTE] },
    remediation: {
      summary: 'Upgrade any cluster below the supported floor to the current long-term-support runtime.',
      cli: editCluster('set spark_version to a supported LTS release'),
      doc_url: 'https://docs.databricks.com/aws/en/release-notes/runtime/',
      caveat:
        'An unsupported runtime receives no security patches, so this is not the same finding as being behind the ' +
        'latest: it is the one to fix before the ones about being current. Check the workload against the release ' +
        'notes first — a major runtime step can change Spark behaviour under it.',
    },
  },
  'SCP-04-07': {
    measurability: 'system-table',
    collector: 'sql:compute.clusters',
    severity: 'high',
    criteria:
      'Every all-purpose cluster runs in a Unity Catalog access mode, so metastore grants apply to whoever ' +
      'attaches to it. A cluster in a legacy or no-isolation mode does not consult the metastore at all, ' +
      'which makes every grant written there advisory. Measured only over clusters whose access mode the ' +
      'system table records: the column is unwritten for rows predating it, and reading unwritten as ' +
      '"no isolation" would report a failure caused by a rollout date.',
    thresholds: bands(1, 0.8),
    applicability: { preconditions: [NO_CLASSIC_COMPUTE] },
    remediation: {
      summary: 'Move each cluster to standard or dedicated access mode, which are the Unity Catalog modes.',
      cli: editCluster('set data_security_mode to USER_ISOLATION, or SINGLE_USER with single_user_name'),
      doc_url: 'https://docs.databricks.com/aws/en/compute/access-mode-limitations',
      caveat:
        'USER_ISOLATION is the shared mode and refuses a few things a no-isolation cluster allowed: RDD APIs, some ' +
        'Scala, arbitrary machine-level access. A workload that depends on one of those wants SINGLE_USER instead, ' +
        'which is still a Unity Catalog mode and still consults the metastore.',
    },
  },
  // The two the security guide routes through the Unity Catalog admin API and the assessment
  // answers from a query it was already running. `derived` rather than `system-table` because
  // nothing is read *about* the metastore: the evidence is that a Unity Catalog view answered,
  // which it cannot do unless a metastore exists and is assigned here. See resolvers/metastore.ts.
  'SCP-04-10': {
    measurability: 'derived',
    collector: 'sql:uc.census',
    severity: 'medium',
    criteria:
      'The workspace resolves a Unity Catalog metastore. Established by reading ' +
      '`system.information_schema`, which resolves through the workspace\'s own metastore assignment, so ' +
      'rows in it are the assignment. Assignment is not adoption: DG-01-02 counts what this metastore ' +
      'governs, and does not claim that is the estate.',
    remediation: {
      summary: 'Assign the workspace to a metastore in its region from the account console.',
      cli:
        'databricks metastores list\n' +
        'databricks metastores assign <workspace-id> <metastore-id> main',
      doc_url: 'https://docs.databricks.com/aws/en/data-governance/unity-catalog/enable-workspaces',
      caveat:
        'An account-admin action, and one metastore per region: a workspace can only be assigned to a metastore in ' +
        'its own region, so a workspace somewhere without one needs the metastore created first.',
    },
  },
  'SCP-04-14': {
    measurability: 'derived',
    collector: 'sql:uc.census',
    severity: 'low',
    criteria:
      'A Unity Catalog metastore exists. Cannot fail: an estate with no metastore cannot answer the ' +
      'queries this assessment is built on, so it reports unmeasured with the collection error rather ' +
      'than as a failure. Recorded as observed because it is the premise the governance pillar rests on.',
    remediation: {
      summary: 'Create a metastore for the workspace region in the account console.',
      cli:
        'databricks metastores create analytics-us-east-1 --region us-east-1\n' +
        'databricks metastores assign <workspace-id> <metastore-id> main',
      doc_url: 'https://docs.databricks.com/aws/en/data-governance/unity-catalog/create-metastore',
      caveat:
        'Created without a storage root on purpose: a metastore-level root is the older pattern and applies to every ' +
        'catalog under it. Give each catalog its own managed location instead, which keeps one team’s data out of ' +
        'another team’s bucket.',
    },
  },
  'SCP-04-16': {
    measurability: 'system-table',
    collector: 'sql:compute.clusters',
    severity: 'high',
    criteria:
      'No cluster runs an init script from a DBFS root. An init script runs as root on every node before ' +
      'the cluster is usable and DBFS has no meaningful access control, so anyone who can write to the path ' +
      'decides what runs — a code execution route that needs no cluster permission. Destinations under ' +
      '/Volumes or /Workspace are governed and are not counted; an unrecognised destination counts as ' +
      'governed, so the finding understates rather than invents.',
    thresholds: bands(1, 0.95),
    applicability: { preconditions: [NO_CLASSIC_COMPUTE] },
    remediation: {
      summary: 'Move init scripts to a Unity Catalog volume or a workspace file and repoint the clusters.',
      cli:
        'databricks volumes create main default init_scripts MANAGED\n' +
        'databricks fs cp dbfs:/databricks/init/install.sh dbfs:/Volumes/main/default/init_scripts/install.sh\n' +
        `${editCluster('point init_scripts at {volumes: {destination: /Volumes/main/default/init_scripts/install.sh}}')}`,
      doc_url: 'https://docs.databricks.com/aws/en/init-scripts/',
      caveat:
        'Grant READ VOLUME narrowly: an init script runs as root on every node, so write access to the volume is ' +
        'root on the cluster. That is the whole reason this finding exists, and copying the script to a volume anyone ' +
        'can write to reproduces it.',
    },
  },
  'SCP-04-18': {
    measurability: 'system-table',
    collector: 'sql:governance.audit_coverage',
    severity: 'high',
    // The control's own title says "or see GOV-3", so the duplication is acknowledged in the
    // source. Joining the alias group means one audit configuration is measured once and scored
    // in both pillars, rather than the security pillar carrying an unmeasured copy of a
    // requirement the governance pillar has already answered.
    alias_group: 'audit-logging',
    criteria:
      'Same measurement as DG-02-02, read as the security-monitoring requirement: audit events are ' +
      'arriving and are no more than two days stale. Scored once through the alias group.',
    thresholds: { max_days_since_event: 2 },
    remediation: AUDIT_SYSTEM_TABLES,
  },
  'REL-03-01': {
    measurability: 'system-table',
    collector: 'sql:compute.clusters',
    severity: 'medium',
    alias_group: 'compute-autoscaling',
    criteria: 'Same requirement as CO-02-01, read from the reliability side. Scored once through the alias group.',
    thresholds: bands(0.8, 0.4),
    applicability: { preconditions: [NO_CLASSIC_COMPUTE] },
  },
  'REL-03-02': {
    measurability: 'system-table',
    collector: 'sql:compute.warehouses',
    severity: 'medium',
    criteria:
      'At least 80% of warehouses scale across a range rather than running at a fixed cluster count, so ' +
      'peaks do not queue and troughs are not paid for.',
    thresholds: bands(0.8, 0.4),
    remediation: {
      summary: 'Set a scaling range and a short auto-stop on each warehouse.',
      cli:
        'databricks warehouses edit abc123def456 --min-num-clusters 1 --max-num-clusters 4 --auto-stop-mins 10',
      doc_url: 'https://docs.databricks.com/aws/en/compute/sql-warehouse/create',
      caveat:
        'Warehouse scaling adds clusters for concurrency, not size: a single slow query is not helped by a wider ' +
        'range, and a queue of small ones is. Raise the cluster size for the first and the maximum count for the ' +
        'second.',
    },
  },

  // ------------------------------------------------------------ operational excellence
  //
  // This pillar's 21 controls all arrived marked `attestation`, which was the seed's
  // default for a pillar whose published text is written about processes. Seven of them
  // name a platform feature as the way the process is carried out, and the feature is
  // observable: bundles, pipelines, managed tables, schedules, policies, catalogs, health
  // rules. Those seven are measured here. The remaining fourteen — source control, MLOps
  // practice, capacity planning, having an operations team — stay questions for a person,
  // because no configuration evidences them.
  'OE-01-06': {
    measurability: 'system-table',
    collector: 'sql:uc.census',
    severity: 'medium',
    criteria:
      'Assets are spread across more than one catalog rather than piled into a single one. Caps at partial: ' +
      'the metastore shows that a boundary exists but not whether it is the environment, domain or team ' +
      'boundary you intended.',
    remediation: {
      summary: 'Choose a catalog boundary — environment, domain or team — and organise catalogs along it.',
      sql:
        "CREATE CATALOG IF NOT EXISTS prod COMMENT 'Production data. Written by scheduled jobs only.';\n" +
        'GRANT USE CATALOG ON CATALOG prod TO `analysts`;\n' +
        'CREATE SCHEMA prod.sales;',
      doc_url: 'https://docs.databricks.com/aws/en/catalogs/',
      caveat:
        'Moving an existing table between catalogs is a copy, not a rename, so pick the boundary before the estate ' +
        'grows into the wrong one. Environment is the boundary most organisations regret not choosing: it is the one ' +
        'that lets a grant say "nobody writes to production by hand".',
    },
  },
  // Was a question until the audit in ADR 0071 asked what would answer it, and the answer was a
  // control already measured three feet away. "Does production logic exist only in a workspace
  // notebook" and "are jobs defined in version-controlled code" are the same reading of the same
  // marker: a bundle deploys the notebook and the job definition together, from the same repository.
  // Joining the group rather than adding a fourth resolver keeps them scoring once, which is what they
  // were always doing to a reader who noticed.
  'OE-01-02': {
    measurability: 'system-table',
    collector: 'sql:jobs.inventory',
    severity: 'medium',
    alias_group: 'infrastructure-as-code',
    criteria:
      'Same measurement as OE-02-01, read as the source-control requirement. Scored once. Caps at partial ' +
      'for the same reason: a Terraform-managed estate carries no marker and cannot be told from a ' +
      'hand-built one, so the absence of bundles asks rather than fails.',
  },
  'OE-02-01': {
    measurability: 'system-table',
    collector: 'sql:jobs.inventory',
    severity: 'medium',
    alias_group: 'infrastructure-as-code',
    criteria:
      'Jobs carry a bundle deployment marker. Caps at partial and never fails: the Terraform provider ' +
      'writes jobs through the same API a person uses and leaves no marker, so an unmarked estate is ' +
      'either Terraform-managed or hand-built and this signal cannot tell them apart.',
    remediation: {
      summary: 'Define jobs and pipelines in a Databricks Asset Bundle and deploy them from CI.',
      // `generate` rather than `init` for an estate that already has jobs: it writes the YAML for
      // what exists, so the first commit describes the current state instead of asking somebody to
      // retype forty jobs from the UI.
      cli:
        'databricks bundle init default-python\n' +
        'databricks bundle generate job --existing-job-id 620112326920 --key nightly_load --bind\n' +
        'databricks bundle deploy --target prod',
      doc_url: 'https://docs.databricks.com/aws/en/dev-tools/bundles/',
      caveat:
        'A deployed bundle takes ownership of the job: edits made in the UI afterwards are reverted on the next ' +
        'deploy. That is the point, and it is worth telling the people who edit those jobs before the first deploy ' +
        'rather than after.',
    },
  },
  'OE-02-02': {
    measurability: 'system-table',
    collector: 'sql:compute.clusters',
    severity: 'medium',
    alias_group: 'compute-templates',
    criteria:
      'At least 90% of all-purpose clusters are created from a compute policy. Not applicable to an ' +
      'all-serverless estate, which exposes no configuration for a template to settle.',
    thresholds: bands(0.9, 0.5),
    applicability: { preconditions: [NO_CLASSIC_COMPUTE] },
    remediation: {
      summary: 'Define compute policies and require them for cluster creation.',
      // A policy family rather than a definition written from scratch: the platform maintains one
      // per workload shape, and overriding two fields on a family is both shorter and less likely
      // to forbid something the workload needs.
      cli:
        'databricks policy-families list\n' +
        'databricks cluster-policies create --name job-compute --policy-family-id job-cluster \\\n' +
        '  --policy-family-definition-overrides \'{"autotermination_minutes": {"type": "fixed", "value": 30}}\'',
      doc_url: 'https://docs.databricks.com/aws/en/admin/clusters/policies',
      caveat:
        'A template only settles the estate if the teams have to use it, which is a permission rather than a policy: ' +
        'while "unrestricted cluster creation" is granted, the next cluster can still be anything.',
    },
  },
  'OE-02-03': {
    measurability: 'system-table',
    collector: 'sql:uc.census',
    severity: 'medium',
    criteria:
      'At least 80% of tables with storage are Unity Catalog managed rather than external, so layout, ' +
      'statistics and cleanup are the platform’s responsibility. Views are excluded — they have no ' +
      'storage to manage.',
    thresholds: bands(0.8, 0.4),
    remediation: {
      summary: 'Create new tables as managed, and convert external tables whose storage you own.',
      // The default is already managed: a CREATE TABLE with no LOCATION is a managed table. So the
      // fix for new tables is a removal, and the statement worth showing is the one that sets the
      // catalog's storage so there is somewhere for them to go.
      sql:
        "ALTER CATALOG main SET MANAGED LOCATION 's3://our-bucket/main';\n" +
        '-- no LOCATION clause, which is what makes it managed\n' +
        'CREATE TABLE main.sales.orders AS SELECT * FROM main.sales.orders_external;',
      doc_url: 'https://docs.databricks.com/aws/en/tables/managed',
      caveat:
        'Converting copies the data, so it costs a write of the table and leaves the old files behind for you to ' +
        'remove. Do it where the storage location is yours and nothing outside Databricks reads the path.',
    },
  },
  'OE-02-04': {
    measurability: 'system-table',
    collector: 'sql:jobs.inventory',
    severity: 'medium',
    criteria:
      'At least 90% of jobs run on a schedule, a trigger or continuously. A paused schedule counts as ' +
      'unautomated, because it fires nothing until someone un-pauses it.',
    thresholds: bands(0.9, 0.6),
    remediation: {
      summary: 'Give each job a schedule or a file-arrival trigger instead of running it by hand.',
      cli:
        'databricks jobs update 620112326920 \\\n' +
        '  --json \'{"new_settings": {"schedule": {"quartz_cron_expression": "0 0 6 * * ?", ' +
        '"timezone_id": "UTC", "pause_status": "UNPAUSED"}}}\'',
      doc_url: 'https://docs.databricks.com/aws/en/jobs/schedule-jobs',
      caveat:
        'PAUSED counts as unautomated here, and it is the state a schedule is most often left in after an incident. ' +
        'A file-arrival trigger is the better answer where the work depends on data landing rather than on the clock.',
    },
  },
  // Was a question until the trigger-type column was checked: a job's own trigger struct already
  // says whether it reacts to file arrival or polls a schedule, so nothing here needs asking. Not
  // banded into a share, because most jobs have nothing to do with files and `trigger_type` carries
  // no marker of which ones do — see resolvers/job-triggers.ts.
  'OE-02-05': {
    measurability: 'system-table',
    collector: 'sql:jobs.inventory',
    severity: 'medium',
    criteria:
      'Passes when any job in the estate is triggered by file arrival. A job on a periodic or cron ' +
      'schedule is not evidence of the opposite: `trigger_type` records how a job starts, not what ' +
      'it does, so an estate with none is unmeasured rather than failed.',
    remediation: {
      summary: 'Replace a schedule that polls for a file with a file-arrival trigger on the same path.',
      cli:
        'databricks jobs update 620112326920 \\\n' +
        '  --json \'{"new_settings": {"trigger": {"file_arrival": ' +
        '{"url": "/Volumes/main/landing/incoming/"}}}}\'',
      doc_url: 'https://docs.databricks.com/aws/en/jobs/file-arrival-triggers',
      caveat:
        'A file-arrival trigger watches one Unity Catalog volume or external location path; a job landing ' +
        'files in several places needs one trigger per path, or a single upstream location the others feed.',
    },
  },
  'OE-02-06': {
    measurability: 'system-table',
    collector: 'sql:pipelines.inventory',
    severity: 'medium',
    alias_group: 'declarative-pipelines',
    criteria:
      'At least half of orchestration is declarative pipelines rather than jobs. The share is biased low ' +
      'on purpose: a job that exists only to start a pipeline counts on the job side, because the jobs ' +
      'inventory does not record which jobs call a pipeline.',
    thresholds: bands(0.5, 0.15),
    remediation: {
      summary: 'Move transformation logic into a declarative pipeline and put it in production mode.',
      // Two halves and the second is the one people forget: a pipeline left in development mode
      // keeps its compute alive between updates and skips the retries, which is the opposite of what
      // production wants.
      cli:
        'databricks bundle init default-python   # a pipeline resource, then\n' +
        'databricks pipelines update 0f1e2d3c --development=false',
      doc_url: 'https://docs.databricks.com/aws/en/dlt/',
      caveat:
        'A job whose only task starts a pipeline still counts on the job side of this measurement, deliberately: the ' +
        'orchestration is the job. Move the transformation itself, not the trigger.',
    },
  },
  'OE-02-11': {
    measurability: 'system-table',
    collector: 'sql:pipelines.inventory',
    severity: 'medium',
    alias_group: 'declarative-pipelines',
    criteria: 'Same measurement as OE-02-06, read as the declarative-management requirement. Scored once.',
    thresholds: bands(0.5, 0.15),
  },
  'OE-04-01': {
    measurability: 'system-table',
    collector: 'sql:jobs.inventory',
    severity: 'medium',
    alias_group: 'job-monitoring',
    criteria:
      'At least 80% of jobs whose definitions record the field carry a health rule. Job definitions older ' +
      'than the health-rules column are excluded from both halves rather than counted as unmonitored.',
    thresholds: bands(0.8, 0.3),
    remediation: {
      summary: 'Add a health rule and a failure notification to each production job.',
      // The rule and the notification together, because either alone is not monitoring: a health
      // rule with nobody subscribed fires into a log, and a failure email without a duration rule
      // says nothing until the run has already failed.
      cli:
        'databricks jobs update 620112326920 \\\n' +
        '  --json \'{"new_settings": {"health": {"rules": [{"metric": "RUN_DURATION_SECONDS", ' +
        '"op": "GREATER_THAN", "value": 5400}]}, "email_notifications": {"on_failure": ' +
        '["platform-oncall@example.com"], "on_duration_warning_threshold_exceeded": ["platform-oncall@example.com"]}}}\'',
      doc_url: 'https://docs.databricks.com/aws/en/jobs/notifications',
      caveat:
        'Set the duration threshold from the job’s own history rather than a round number: a rule at twice the ' +
        'normal runtime catches a hang, and one at ten times catches nothing.',
    },
  },
  'OE-04-02': {
    measurability: 'system-table',
    collector: 'sql:jobs.inventory',
    severity: 'medium',
    alias_group: 'job-monitoring',
    criteria:
      'Same measurement as OE-04-01, read as the native-and-external-tooling requirement. Scored once. ' +
      'External monitoring built on the audit logs is invisible here, which is what the attestation asks about.',
    thresholds: bands(0.8, 0.3),
  },
  // Converted from attestation: system.query.history records waiting_at_capacity_duration_ms per
  // statement, so capacity limits actually biting are measurable after the fact. Whether monitoring is
  // proactive — watching headroom before a limit bites — is an account-plane question with no workspace
  // source, so the outcome caps at partial in all non-empty cases.
  'OE-03-01': {
    measurability: 'system-table',
    collector: 'sql:query.capacity',
    severity: 'medium',
    criteria:
      'Statements with waiting_at_capacity_duration_ms > 0 prove a service limit was reached. ' +
      'Any positive count → partial (limits are biting; monitoring cannot be confirmed). ' +
      'Zero → partial (no events detected, but proactive monitoring is beyond telemetry). ' +
      'No queries at all → not-applicable. Caps at partial in all non-empty cases because headroom ' +
      'and forward awareness are account-plane facts not visible from the workspace.',
    thresholds: { partial_share: 0.01 },
    remediation: {
      summary:
        'Review your account service limits and quotas in the admin console. If statements are regularly ' +
        'waiting at capacity, raise a support ticket to increase the relevant quota, or reduce peak ' +
        'concurrency by staggering scheduled jobs.',
      cli:
        '# Query capacity events from the last 30 days\n' +
        'databricks statement-execution execute --warehouse-id <id> \\\n' +
        '  --statement "SELECT workspace_id, COUNT(*) as events, SUM(waiting_at_capacity_duration_ms) ' +
        'as total_wait_ms FROM system.query.history WHERE start_time >= current_timestamp() - ' +
        'make_dt_interval(30) AND waiting_at_capacity_duration_ms > 0 GROUP BY 1 ORDER BY 2 DESC"',
      doc_url: 'https://docs.databricks.com/aws/en/admin/account-settings/service-quotas.html',
      caveat:
        'Account-level quota headroom is visible in the account console under Settings → Quotas, not in ' +
        'a workspace system table. Set up a Databricks alert on waiting_at_capacity_duration_ms from ' +
        'system.query.history if sustained capacity pressure is observed.',
    },
  },
  // Converted from attestation: custom models on managed serving endpoints and job-sourced MLflow runs
  // together evidence that MLOps tooling is in use. Caps at partial — the presence of the right platform
  // features does not prove the process is documented or enforced. Empty on both signals → unmeasurable,
  // following the same asymmetry as PE-02-02.
  'OE-01-04': {
    measurability: 'system-table',
    collector: 'sql:serving.model_entities',
    severity: 'medium',
    criteria:
      'Custom models on managed serving endpoints and job-sourced MLflow runs together evidence that ' +
      'MLOps tooling is in use. Caps at partial: the presence of the right platform features does not ' +
      'prove the process is documented, gated or reproducible. Empty on both signals → unmeasurable, ' +
      'following the same asymmetry as PE-02-02: a workspace serving models from its own service or ' +
      'training on a separate platform leaves nothing here to read.',
    remediation: {
      summary:
        'Define the end-to-end path a model takes from experiment to production: training run tracked in ' +
        'MLflow, model registered in Unity Catalog with a version, served through a managed endpoint ' +
        'pinned to that version.',
      sql:
        '-- Register the model from a tracked run\n' +
        'CREATE MODEL IF NOT EXISTS prod.models.fraud_scoring;\n' +
        '-- Tag the experiment for auditability\n' +
        "ALTER EXPERIMENT 'fraud/experiments/v3' SET TAGS ('team' = 'data-science', 'env' = 'prod');",
      doc_url: 'https://docs.databricks.com/aws/en/machine-learning/manage-model-lifecycle/',
    },
  },
  // Also a question until ADR 0071. "Is job duration tracked over time, so a job that has doubled is
  // visible" is what a `RUN_DURATION_SECONDS` health rule is for, and the group already counts them —
  // so this was asking a person to confirm a column the scan had already read. It joins rather than
  // getting its own resolver because a second reading of the same field would be a second number to
  // reconcile, and the first one to drift would look like a bug in whichever page showed it.
  'PE-05-04': {
    measurability: 'system-table',
    collector: 'sql:jobs.inventory',
    severity: 'medium',
    alias_group: 'job-monitoring',
    criteria:
      'Same measurement as OE-04-01, read as the job-performance requirement. Scored once. A duration ' +
      'health rule is what makes a job that has slowed visible without somebody watching it.',
    thresholds: bands(0.8, 0.3),
  },
  // Was a question until `health_rules` was checked for a streaming-backlog metric: the platform
  // records the same rule the question asks about, on the same jobs OE-04-01 reads for health rules
  // generally. Its own resolver rather than a fourth member of that alias group, because the
  // population is narrower — continuous jobs only, the trigger a streaming job stays running under —
  // and joining a group that scores over all jobs would blur the two. See resolvers/job-triggers.ts.
  'PE-05-03': {
    measurability: 'system-table',
    collector: 'sql:jobs.inventory',
    severity: 'medium',
    criteria:
      'At least 80% of continuous jobs whose health rules are recorded carry a streaming-backlog rule ' +
      '(`STREAMING_BACKLOG_BYTES`, `_RECORDS`, `_SECONDS` or `_FILES`). An estate with no continuous job ' +
      'is not applicable: there is no streaming workload for a backlog alert to watch.',
    thresholds: bands(0.8, 0.3),
    remediation: {
      summary: 'Add a streaming-backlog health rule and its notification to each continuous job.',
      cli:
        'databricks jobs update 620112326920 \\\n' +
        '  --json \'{"new_settings": {"health": {"rules": [{"metric": "STREAMING_BACKLOG_SECONDS", ' +
        '"op": "GREATER_THAN", "value": 300}]}, "email_notifications": {"on_streaming_backlog_exceeded": ' +
        '["platform-oncall@example.com"]}}}\'',
      doc_url: 'https://docs.databricks.com/aws/en/jobs/notifications',
      caveat:
        'Requires the Jobs service to track the streaming query directly — a task calling `awaitTermination()` ' +
        'blocks the driver and hides the query from it, so the rule never fires. Pick the metric (bytes, ' +
        'records, seconds or files) that matches what a consumer of the output actually cares about.',
    },
  },

  // ---------------------------------------------------- interoperability and usability
  //
  // Also seeded entirely as `attestation`, and wrongly: Delta Sharing, Lakehouse
  // Federation and recipient configuration are readable through
  // `system.information_schema` with the `sql` scope, even though the REST APIs for the
  // same objects need scopes no app install can hold (ADR 0016). Nine of the fifteen are
  // measured. What stays attested is judgement about intent — whether a pattern is the
  // standard one, whether a partner tool is certified, whether the business trusts a
  // published product.
  'IU-01-02': {
    measurability: 'system-table',
    collector: 'sql:uc.platform_census',
    severity: 'medium',
    criteria:
      'Lakehouse Federation connections exist, so external sources are queried in place with pushdown ' +
      'rather than extracted on a schedule. An estate with none is unmeasured rather than failed: managed ' +
      'ingestion connectors, Auto Loader and partner tools register no connection.',
    remediation: {
      summary: 'Register external databases as federated connections instead of building extracts.',
      // secret() rather than a literal, because a connection is a persisted object: a password
      // pasted into this statement is a password stored in the metastore and readable by anyone who
      // can describe the connection.
      sql:
        'CREATE CONNECTION postgres_prod TYPE postgresql\n' +
        "  OPTIONS (host 'db.internal', port '5432', user secret('warehouse', 'user'), " +
        "password secret('warehouse', 'password'));\n" +
        "CREATE FOREIGN CATALOG postgres_prod USING CONNECTION postgres_prod OPTIONS (database 'orders');",
      doc_url: 'https://docs.databricks.com/aws/en/query-federation/',
      caveat:
        'Federation queries the source system, so a heavy query runs against the database somebody else depends on. ' +
        'Where the load matters, federate first and then materialise the parts that are read often — which is still ' +
        'a smaller job than maintaining an extract pipeline.',
    },
  },
  'IU-01-05': {
    measurability: 'system-table',
    collector: 'sql:jobs.inventory',
    severity: 'medium',
    alias_group: 'infrastructure-as-code',
    criteria: 'Same measurement as OE-02-01, read from the interoperability side. Scored once.',
  },
  'IU-02-01': {
    measurability: 'system-table',
    collector: 'sql:uc.census',
    severity: 'medium',
    alias_group: 'open-table-formats',
    criteria:
      'Same requirement as CO-01-01, read as the open-format requirement: the reason to prefer Delta or ' +
      'Iceberg is that another engine can read it without a copy. Scored once through the alias group.',
    thresholds: bands(0.95, 0.7),
  },
  'IU-02-02': {
    measurability: 'system-table',
    collector: 'sql:uc.platform_census',
    severity: 'medium',
    criteria:
      'Where data crosses the account boundary it travels through Delta Sharing, with shares actually ' +
      'granted to recipients. An estate that shares nothing is not applicable rather than failing — ' +
      'whether to share is a business decision, not a posture defect.',
    remediation: {
      summary: 'Publish shared datasets through Delta Sharing rather than exporting copies.',
      sql:
        'CREATE SHARE IF NOT EXISTS sales_products;\n' +
        'ALTER SHARE sales_products ADD TABLE main.sales.orders;\n' +
        "CREATE RECIPIENT acme USING ID 'aws:us-west-2:<their-sharing-identifier>';\n" +
        'GRANT SELECT ON SHARE sales_products TO RECIPIENT acme;',
      doc_url: 'https://docs.databricks.com/aws/en/delta-sharing/',
      caveat:
        'A recipient without a sharing identifier is on the open protocol instead, which authenticates with a ' +
        'bearer token you have to deliver and rotate. Prefer the Databricks-to-Databricks form where the other side ' +
        'has an account.',
    },
  },
  'IU-03-02': {
    measurability: 'system-table',
    collector: 'sql:cost.compute_mix',
    severity: 'medium',
    alias_group: 'serverless-adoption',
    criteria: 'Same requirement as CO-01-06, read from the interoperability side. Scored once through the alias group.',
    thresholds: bands(0.8, 0.3),
  },
  'IU-03-03': {
    measurability: 'system-table',
    collector: 'sql:compute.clusters',
    severity: 'medium',
    alias_group: 'compute-templates',
    criteria: 'Same measurement as OE-02-02, read as the predefined-templates requirement. Scored once.',
    thresholds: bands(0.9, 0.5),
    applicability: { preconditions: [NO_CLASSIC_COMPUTE] },
  },
  'IU-03-04': {
    measurability: 'rest-api',
    collector: 'rest:workspace:serving-endpoints',
    severity: 'medium',
    criteria:
      'Model serving or vector search endpoints exist. Read from the two control-plane scopes an app can ' +
      'actually be granted. SQL AI functions, Genie and the assistant leave no endpoint behind, so an ' +
      'estate using only those is unmeasured rather than failing — which is what the attestation asks about.',
    remediation: {
      summary: 'Use Model Serving, Vector Search or AI functions instead of building the equivalent yourself.',
      // A pay-per-token endpoint on a platform model is the cheapest thing that satisfies this and
      // the most likely to be useful: no model to train, nothing to size, and it scales to zero.
      cli:
        'databricks serving-endpoints create summarise \\\n' +
        '  --json \'{"config": {"served_entities": [{"name": "llama", ' +
        '"entity_name": "system.ai.llama_v3_3_70b_instruct", "entity_version": "1", ' +
        '"scale_to_zero_enabled": true, "workload_size": "Small"}]}}\'',
      doc_url: 'https://docs.databricks.com/aws/en/machine-learning/model-serving/',
      caveat:
        'The SQL ai_* functions need no endpoint at all and are the right answer for classification, extraction and ' +
        'summarisation inside a query. They leave nothing behind for this control to read, which is why an estate ' +
        'using only those reports as unmeasured rather than failing.',
    },
  },
  'IU-04-01': {
    measurability: 'system-table',
    collector: 'sql:uc.platform_census',
    severity: 'medium',
    alias_group: 'data-products',
    criteria:
      'Published assets carry tags, so a consumer can tell a product from a working table. Caps at partial: ' +
      'whether the business trusts them is not something the metastore records.',
    remediation: {
      summary: 'Tag published tables with their status and owner so consumers can tell what to build on.',
      sql:
        "ALTER TABLE main.sales.orders SET TAGS ('certification' = 'gold', 'owner' = 'sales-platform');\n" +
        "ALTER SCHEMA main.sales SET TAGS ('layer' = 'published');",
      doc_url: 'https://docs.databricks.com/aws/en/database-objects/tags',
      caveat:
        'Tag the schema where a whole layer shares a status, and the table where it does not. Tagging every table ' +
        'individually is how a tagging convention stops being maintained.',
    },
  },
  'IU-04-02': {
    measurability: 'system-table',
    collector: 'sql:uc.platform_census',
    severity: 'medium',
    alias_group: 'data-products',
    criteria: 'Same measurement as IU-04-01, read as the semantic-consistency requirement. Scored once.',
  },
  'IU-04-03': {
    measurability: 'system-table',
    collector: 'sql:uc.census',
    severity: 'medium',
    criteria:
      'Scored on the weaker of description and lineage rather than their average, because discovery fails ' +
      'at its weakest link: a table nobody described is not findable, and a well-described one with no ' +
      'lineage cannot be traced to its source. Registration is not scored — every table the census can ' +
      'see is already in Unity Catalog — and an empty lineage window drops lineage out of the verdict ' +
      'rather than scoring it as zero.',
    thresholds: bands(0.7, 0.3),
    remediation: {
      summary: 'Describe the tables consumers use, and run production work on compute that emits lineage.',
      // Scored on the weaker of two shares, so the fix is an order of work rather than a command:
      // improving the one that is already fine moves the number not at all.
      by_hand:
        'The finding reports two shares — described, and appearing in lineage — and the score is the weaker of ' +
        'them, so start there. Descriptions are the one you can change directly, with COMMENT ON TABLE. Lineage ' +
        'cannot be written at all: it accumulates as workloads run through Unity Catalog compute, so the fix for ' +
        'that share is the compute, and then waiting. An empty lineage window is left out of the verdict rather ' +
        'than scored as zero, so do not invent lineage work to fill a fortnight nothing ran in. Registration is ' +
        'not a third share: every table the census can see is already in Unity Catalog.',
      doc_url: 'https://docs.databricks.com/aws/en/discover/',
    },
  },
};

/**
 * The extension controls, which were authored rather than generated and so already
 * carry their own evaluation metadata in the pillar files. Listed so the enricher can
 * tell "deliberately not in the table" from "forgotten", and so the status flip below
 * is explicit about which of them now have working resolvers.
 */
export const IMPLEMENTED_EXTENSIONS = ['CO-03-05', 'CO-03-06', 'CO-03-07', 'REL-04-05'];

/**
 * Security-guide controls that now have working resolvers.
 *
 * A separate list from the enrichment table because these controls already carry their
 * criteria, severity and collector from the security guide they were ported from. Putting
 * them in the table would mean restating that metadata here, and then owning it: the
 * table replaces the fields it owns, so a control listed there would lose the delegated
 * criteria it was ported with and gain a paraphrase of it maintained in a second place.
 *
 * Only the status flips, and only when a resolver exists — which CI checks in both
 * directions, so this list cannot drift from the registry.
 */
export const IMPLEMENTED_DELEGATED = [
  // Workspace settings, all fifteen from one workspace-conf call.
  'SCP-01-04',
  'SCP-02-04',
  'SCP-02-05',
  'SCP-02-06',
  'SCP-02-07',
  'SCP-02-08',
  'SCP-02-12',
  'SCP-03-10',
  'SCP-04-08',
  'SCP-04-09',
  'SCP-05-04',
  'SCP-05-05',
  'SCP-05-06',
  'SCP-05-07',
  'SCP-05-15',
  // Token management.
  'SCP-01-03',
  'SCP-01-05',
  'SCP-04-01',
  // Model serving. SCP-03-07 reads only the endpoint list, which is enough to decide whether the
  // requirement applies at all — the protection in front of the endpoints needs the "networking"
  // scope and the account plane, neither of which any install can hold, so that half is attested.
  'SCP-05-10',
  'SCP-03-07',
  // Vector search, the second and last grantable control-plane scope in this pillar.
  'SCP-02-09',
  // System-table re-targets (Task B): these carried their own criteria and remediation from the
  // security guide; only the evaluator_status flip is managed here. Measurability and collector
  // are updated directly in the YAML because the enrichment table would otherwise overwrite the
  // delegated criteria with a paraphrase of the same text.
  'SCP-04-05',
  'SCP-04-22',
  // Admin-evidence controls (Task C): registered resolvers read imported admin signals.
  // All carry their criteria, severity and collector from the security guide; only the
  // evaluator_status flip is managed here. Remediation by_hand is written directly in the
  // YAML because the enrichment table would replace the delegated remediation fields.
  'SCP-01-06',
  'SCP-02-01',
  'SCP-02-02',
  'SCP-02-10',
  'SCP-02-11',
  'SCP-03-05',
  'SCP-03-08',
  'SCP-03-12',
  'SCP-04-02',
  'SCP-04-03',
  'SCP-04-19',
  'SCP-04-20',
  'SCP-04-21',
  'SCP-05-11',
  'SCP-05-13',
  'SCP-05-14',
];
