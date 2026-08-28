/*
 * Which relations between the five estate object kinds are readable from system tables this app already
 * queries, and how many rows each returns. Row `32h`.
 *
 * `32i` is an XL that draws a canvas, and its own rule is that a node exists only where a row exists and
 * an edge only where one field joins two rows — never from a shared name, tag, workspace or bill. Nothing
 * had checked which edges survive that rule, so the scope of an XL rested on an assumption. This is the
 * check, in its own pull request, in the shape `H1b` set: measure the premise before building for it.
 *
 * Live and optional, like the other `measure-` scripts. Nothing in `npm run verify` runs it and what it
 * writes is committed by hand.
 *
 *   cd app && env -u DATABRICKS_TOKEN DATABRICKS_CONFIG_PROFILE=your-profile \
 *     DATABRICKS_HOST=<host> DATABRICKS_WAREHOUSE_ID=<id> \
 *     stdbuf -oL -eL node scripts/measure-topology-sources.mjs
 *
 * ## What a probe answers, and why it is three questions rather than one
 *
 * [ADR 0074](../../docs/decisions/0074-an-emptiness-the-scan-cannot-establish-is-unmeasured-rather-than-not-applicable.md)
 * is the whole design here. A relation that returns nothing has done so for one of three reasons and they
 * mean opposite things:
 *
 *   - **the column is not there** — this workspace's system schema does not carry the field, so the
 *     relation is unreadable everywhere on it and no estate will change that;
 *   - **the read was refused** — a grant, which is a fact about this app's permissions;
 *   - **there were no rows** — a fact about this estate in this window, and the next estate may differ.
 *
 * So every probe states its columns before it runs — see `columnsOf` for which catalogue it asks — and a
 * failure is recorded with its message rather than folded into a zero. A zero that cannot say which of
 * the three it is would let `32i` scope itself out of an edge that exists.
 *
 * There is a fourth reason, which no column check catches and one probe here found: **the join was
 * wrong**. `job → job` read 0 over 35 rows until the far end was joined to the table that numbers task
 * runs rather than the one that numbers job runs. Nothing in the recording distinguishes that from an
 * estate where no job starts another, which is why a zero on a relation with rows in its source gets a
 * second query before it is written down.
 *
 * ## What it cannot say
 *
 * **A count here is a count on this estate in this window.** The scale half of `32h`'s question needs an
 * estate with volume in it, and labs has seven jobs. Read the recording's `profile` before quoting a
 * number as a property of the relation.
 *
 * **It measures endpoints, not whether they are addressable.** An edge whose far end is an id with no row
 * in the app's own inventory is not an edge between two estate objects — it is an edge to a string. Each
 * probe that can resolve its endpoints does, and reports the share that resolved, because that share is
 * the difference between a topology and a drawing.
 *
 * **It writes after every probe.** `70` lost two thirds of a three-hour reading to a script that wrote
 * once at the end.
 *
 * ## Every probe is counted by one aggregate, and that is the apparatus
 *
 * A relation supplies a `pairs` query returning `from_id` and `to_id`, and nothing else. The counting is
 * done here, once, for all of them.
 *
 * The first version let each probe write its own aggregate and every one of them counted
 * `count(DISTINCT concat_ws('>', a, b))`. `concat_ws` **skips nulls**, so a row whose far end was null
 * still produced a distinct string, and a relation with no far end at all reported edges: `job → cluster`
 * came back as 7 edges between 7 jobs and 0 clusters, which is seven job ids wearing an edge's clothes.
 * The reading that gave it away was the bill probe — 15 edges over 7 and 7 ends from a single row naming
 * both, which is 7 + 7 + 1 and arithmetic rather than a topology. One aggregate for every probe is what
 * makes that impossible to reintroduce per relation.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { corpusSettings, runStatement } from './plan-corpus.mjs';
import { refuseUnlessNamedForItsEstate } from './recording-guards.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'server', 'collect', 'sql', 'runtime-baseline');

const { profile, host, warehouse } = corpusSettings;
const DAYS = Number(process.env.LOOKBACK_DAYS ?? 30);
/** Generous, because two of these probes join `query.history` to lineage on a large estate. */
const POLLS = Number(process.env.STATEMENT_POLLS ?? 450);

if (!host) throw new Error('DATABRICKS_HOST is required');
if (!warehouse) throw new Error('DATABRICKS_WAREHOUSE_ID is required');

const path = join(OUT, `${profile}-topology-sources.json`);
refuseUnlessNamedForItsEstate(path, profile, host);

const days = [{ name: 'days', value: String(DAYS), type: 'INT' }];

/**
 * Counts one relation, given a query that yields nothing but `from_id` and `to_id`.
 *
 * `edges` and both endpoint counts are taken over the rows that name **both** ends, because a row with one
 * end is not an edge — see the header for the reading that established that the hard way. `rows` and
 * `rowsNamingBothEnds` are kept beside them so the share is visible rather than inferred: a relation whose
 * source carries ten thousand rows and forty edges is a different proposition from one with forty of each.
 */
function counted(pairs) {
  return `
    WITH pairs AS (${pairs}),
    edges AS (SELECT from_id, to_id FROM pairs WHERE from_id IS NOT NULL AND to_id IS NOT NULL)
    SELECT
      (SELECT count(*) FROM pairs)                                        AS rows_scanned,
      (SELECT count(*) FROM edges)                                        AS rows_naming_both_ends,
      (SELECT count(DISTINCT concat_ws('>', from_id, to_id)) FROM edges)  AS edges,
      (SELECT count(DISTINCT from_id) FROM edges)                         AS from_ends,
      (SELECT count(DISTINCT to_id) FROM edges)                           AS to_ends`;
}

/**
 * The relations, each with the columns it needs and the pairs it draws.
 *
 * `from` and `to` are the five kinds `locate.ts` declares, because those are the objects the app can
 * already address — an edge to something with no page is not an edge this product can draw. `refused`
 * marks a relation the row's own rule declines rather than one the platform cannot answer; it is measured
 * anyway, so what the rule costs is a number instead of a guess.
 */
const RELATIONS = [
  {
    id: 'table-to-table',
    label: 'table → table, from lineage',
    from: 'table',
    to: 'table',
    source: 'system.access.table_lineage',
    needs: [['access', 'table_lineage', ['source_table_full_name', 'target_table_full_name', 'event_date']]],
    scalesWith: 'one per source and target pair',
    pairs: `
      SELECT source_table_full_name AS from_id, target_table_full_name AS to_id
      FROM system.access.table_lineage
      WHERE event_date >= current_date() - INTERVAL :days DAYS`,
  },
  {
    id: 'job-to-table',
    label: 'job → table, from lineage',
    from: 'job',
    to: 'table',
    source: 'system.access.table_lineage',
    needs: [['access', 'table_lineage', ['entity_type', 'entity_id']]],
    scalesWith: 'one per job and table pair',
    pairs: `
      SELECT entity_id AS from_id,
             coalesce(target_table_full_name, source_table_full_name) AS to_id
      FROM system.access.table_lineage
      WHERE event_date >= current_date() - INTERVAL :days DAYS AND entity_type = 'JOB'`,
  },
  {
    id: 'pipeline-to-table',
    label: 'pipeline → table, from lineage',
    from: 'pipeline',
    to: 'table',
    source: 'system.access.table_lineage',
    needs: [['access', 'table_lineage', ['entity_type', 'entity_id']]],
    scalesWith: 'one per pipeline and table pair',
    pairs: `
      SELECT entity_id AS from_id,
             coalesce(target_table_full_name, source_table_full_name) AS to_id
      FROM system.access.table_lineage
      WHERE event_date >= current_date() - INTERVAL :days DAYS AND entity_type = 'PIPELINE'`,
  },
  {
    id: 'job-to-cluster',
    label: 'job → cluster, from the task run timeline',
    from: 'job',
    to: 'cluster',
    source: 'system.lakeflow.job_task_run_timeline',
    needs: [['lakeflow', 'job_task_run_timeline', ['job_id', 'compute']]],
    scalesWith: 'one per job and cluster pair',
    // `compute` rather than `compute_ids`, because the array of ids does not say what kind of id each is
    // and a serverless compute id is not a cluster. The struct names the field it belongs in.
    pairs: `
      SELECT t.job_id AS from_id, c.cluster_id AS to_id
      FROM system.lakeflow.job_task_run_timeline t
      LATERAL VIEW OUTER explode(t.compute) e AS c
      WHERE t.period_start_time >= current_date() - INTERVAL :days DAYS`,
    // The far end is only an estate object where the app's own cluster inventory holds it.
    resolves: {
      what: 'cluster ids that are rows in system.compute.clusters',
      sql: `
        WITH ends AS (
          SELECT DISTINCT c.cluster_id
          FROM system.lakeflow.job_task_run_timeline t
          LATERAL VIEW OUTER explode(t.compute) e AS c
          WHERE t.period_start_time >= current_date() - INTERVAL :days DAYS AND c.cluster_id IS NOT NULL
        )
        SELECT
          (SELECT count(*) FROM ends) AS ends,
          (SELECT count(*) FROM ends WHERE cluster_id IN (SELECT cluster_id FROM system.compute.clusters)) AS ends_resolved`,
    },
  },
  {
    id: 'job-to-warehouse',
    label: 'job → warehouse, from the task run timeline',
    from: 'job',
    to: 'warehouse',
    source: 'system.lakeflow.job_task_run_timeline',
    needs: [['lakeflow', 'job_task_run_timeline', ['job_id', 'compute']]],
    scalesWith: 'one per job and warehouse pair',
    pairs: `
      SELECT t.job_id AS from_id, c.warehouse_id AS to_id
      FROM system.lakeflow.job_task_run_timeline t
      LATERAL VIEW OUTER explode(t.compute) e AS c
      WHERE t.period_start_time >= current_date() - INTERVAL :days DAYS`,
  },
  {
    id: 'pipeline-to-cluster',
    label: 'pipeline → cluster, from the update timeline',
    from: 'pipeline',
    to: 'cluster',
    source: 'system.lakeflow.pipeline_update_timeline',
    needs: [['lakeflow', 'pipeline_update_timeline', ['pipeline_id', 'compute']]],
    scalesWith: 'one per pipeline and cluster pair',
    pairs: `
      SELECT pipeline_id AS from_id, compute.cluster_id AS to_id
      FROM system.lakeflow.pipeline_update_timeline
      WHERE period_start_time >= current_date() - INTERVAL :days DAYS`,
    // Asked for the same reason as the job's, and it turns out to matter more: this far end is one cluster
    // per update rather than one per pipeline, so whether those ids are estate objects decides whether the
    // relation is a topology or a run log.
    resolves: {
      what: 'cluster ids that are rows in system.compute.clusters',
      sql: `
        WITH ends AS (
          SELECT DISTINCT compute.cluster_id AS cluster_id
          FROM system.lakeflow.pipeline_update_timeline
          WHERE period_start_time >= current_date() - INTERVAL :days DAYS AND compute.cluster_id IS NOT NULL
        )
        SELECT
          (SELECT count(*) FROM ends) AS ends,
          (SELECT count(*) FROM ends WHERE cluster_id IN (SELECT cluster_id FROM system.compute.clusters)) AS ends_resolved`,
    },
  },
  {
    id: 'warehouse-to-table',
    label: 'warehouse → table, lineage joined to query history by statement',
    from: 'warehouse',
    to: 'table',
    source: 'system.access.table_lineage ⋈ system.query.history',
    needs: [
      ['access', 'table_lineage', ['statement_id']],
      ['query', 'history', ['statement_id', 'compute']],
    ],
    scalesWith: 'one per warehouse and table pair',
    pairs: `
      SELECT r.warehouse_id AS from_id, t.table_name AS to_id
      FROM (
        SELECT statement_id,
               coalesce(target_table_full_name, source_table_full_name) AS table_name
        FROM system.access.table_lineage
        WHERE event_date >= current_date() - INTERVAL :days DAYS AND statement_id IS NOT NULL
      ) t
      LEFT JOIN (
        SELECT statement_id, compute.warehouse_id AS warehouse_id
        FROM system.query.history
        WHERE start_time >= current_date() - INTERVAL :days DAYS
      ) r ON r.statement_id = t.statement_id`,
  },
  {
    id: 'cluster-to-table',
    label: 'cluster → table, lineage joined to query history by statement',
    from: 'cluster',
    to: 'table',
    source: 'system.access.table_lineage ⋈ system.query.history',
    needs: [
      ['access', 'table_lineage', ['statement_id']],
      ['query', 'history', ['statement_id', 'compute']],
    ],
    scalesWith: 'one per cluster and table pair',
    pairs: `
      SELECT r.cluster_id AS from_id, t.table_name AS to_id
      FROM (
        SELECT statement_id,
               coalesce(target_table_full_name, source_table_full_name) AS table_name
        FROM system.access.table_lineage
        WHERE event_date >= current_date() - INTERVAL :days DAYS AND statement_id IS NOT NULL
      ) t
      LEFT JOIN (
        SELECT statement_id, compute.cluster_id AS cluster_id
        FROM system.query.history
        WHERE start_time >= current_date() - INTERVAL :days DAYS
      ) r ON r.statement_id = t.statement_id`,
    // This relation is zero on both estates measured, including one with hundreds of classic clusters, so
    // the zero needs a cause before it can be read as one. Two would produce it and they are different
    // findings: the statements lineage names are not in query history at all, or they are and their
    // compute is a warehouse. The diagnostic separates them.
    diagnostic: {
      what: 'where the lineage-to-query-history join goes',
      sql: `
        WITH touched AS (
          SELECT DISTINCT statement_id
          FROM system.access.table_lineage
          WHERE event_date >= current_date() - INTERVAL :days DAYS AND statement_id IS NOT NULL
        ),
        ran AS (
          SELECT statement_id, compute.type AS kind, compute.cluster_id AS cluster_id,
                 compute.warehouse_id AS warehouse_id
          FROM system.query.history
          WHERE start_time >= current_date() - INTERVAL :days DAYS
        )
        SELECT
          count(*)                                                          AS statements_in_lineage,
          sum(CASE WHEN r.statement_id IS NULL THEN 1 ELSE 0 END)           AS not_in_query_history,
          sum(CASE WHEN r.warehouse_id IS NOT NULL THEN 1 ELSE 0 END)       AS ran_on_a_warehouse,
          sum(CASE WHEN r.cluster_id IS NOT NULL THEN 1 ELSE 0 END)         AS ran_on_a_cluster,
          sum(CASE WHEN r.statement_id IS NOT NULL AND r.cluster_id IS NULL
                    AND r.warehouse_id IS NULL THEN 1 ELSE 0 END)           AS matched_naming_neither
        FROM touched t
        LEFT JOIN ran r ON r.statement_id = t.statement_id`,
    },
  },
  {
    id: 'job-to-job',
    label: 'job → job, from a run that another run started',
    from: 'job',
    to: 'job',
    source: 'system.lakeflow.job_run_timeline ⋈ system.lakeflow.job_task_run_timeline',
    needs: [
      ['lakeflow', 'job_run_timeline', ['job_id', 'source_task_run_id']],
      ['lakeflow', 'job_task_run_timeline', ['job_id', 'run_id']],
    ],
    scalesWith: 'one per triggering and triggered job pair',
    // The far end is a **task** run and the two timelines number their runs separately, so this joins the
    // task timeline rather than the run timeline. Joined to `job_run_timeline.run_id` instead, the relation
    // reads 0 edges over 35 rows on an estate where all 35 match on the other table — a zero that would
    // have been recorded as "no job starts another here" and is a fact about the join.
    pairs: `
      WITH child AS (
        SELECT DISTINCT job_id, source_task_run_id
        FROM system.lakeflow.job_run_timeline
        WHERE period_start_time >= current_date() - INTERVAL :days DAYS AND source_task_run_id IS NOT NULL
      ),
      tasks AS (
        SELECT DISTINCT run_id, job_id
        FROM system.lakeflow.job_task_run_timeline
        WHERE period_start_time >= current_date() - INTERVAL :days DAYS
      )
      SELECT parent.job_id AS from_id, child.job_id AS to_id
      FROM child
      LEFT JOIN tasks parent ON parent.run_id = child.source_task_run_id`,
  },
  {
    id: 'bill-derived-pairs',
    label: 'job → cluster, from one usage record naming both',
    from: 'job',
    to: 'cluster',
    source: 'system.billing.usage',
    needs: [['billing', 'usage', ['usage_metadata']]],
    scalesWith: 'one per job and cluster pair',
    // Measured and then declined. `32i`'s rule refuses an edge drawn from a bill, and the reason is that a
    // usage record attributes a cost rather than asserting a relation: two ids on one row say the charge
    // was apportioned between them, which is not the same claim as "this job ran on that cluster". The
    // number is here so the rule's cost is known rather than assumed.
    refused: "32i's rule declines an edge drawn from a bill",
    pairs: `
      SELECT usage_metadata.job_id AS from_id, usage_metadata.cluster_id AS to_id
      FROM system.billing.usage
      WHERE usage_date >= current_date() - INTERVAL :days DAYS`,
  },
];

/**
 * Whether the fields a probe reads are on this workspace's system tables.
 *
 * Run before the probe rather than inferred from its failure, because the two produce the same zero and
 * mean opposite things — see ADR 0074 at the top. A column absent here says the relation is unreadable on
 * this workspace whatever the estate does; an empty probe says only that this window held nothing.
 *
 * **`DESCRIBE TABLE` rather than `system.information_schema.columns`, and the reason is `70`.** That row
 * measured a statement referencing `information_schema.columns` spending 3,979,324 ms of a 3,984,316 ms
 * run on compilation, on a workspace holding 495,135 relations, because the planner loads the estate's
 * column metadata before a predicate is applied to a row. Whether a literal `table_catalog = 'system'`
 * prunes that is [`71`](../../docs/plan/61-discovery-statement-cost.md)'s open question and nothing has
 * tested it. `DESCRIBE` asks the catalog about one table instead of reading a view over every column in
 * the metastore, so this apparatus does not depend on the answer.
 *
 * Cached per table, because eight of these probes want the same four tables and a metadata round trip per
 * probe is the harness measuring itself.
 */
const described = new Map();

async function columnsOf(schema, table) {
  const at = `system.${schema}.${table}`;
  const known = described.get(at);
  if (known != null) return known;

  const rows = await runStatement(`DESCRIBE TABLE ${at}`);
  // `DESCRIBE` appends a blank row and a partition section on some tables, and neither is a column.
  const held = new Set(
    rows
      .map((row) => String(row.col_name ?? ''))
      .filter((name) => name !== '' && !name.startsWith('#'))
  );
  described.set(at, held);
  return held;
}

async function columnsPresent(needs) {
  const checked = [];
  for (const [schema, table, columns] of needs) {
    const held = await columnsOf(schema, table);
    checked.push({
      table: `system.${schema}.${table}`,
      wanted: columns,
      absent: columns.filter((column) => !held.has(column)),
    });
  }
  return checked;
}

const probes = [];

function record() {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        what: "Which relations between the five estate object kinds are readable, for 32h's scope question.",
        profile,
        host,
        warehouse,
        lookbackDays: DAYS,
        takenAt: new Date().toISOString(),
        probesAsked: RELATIONS.length,
        probesHeld: probes.length,
        kinds: ['job', 'cluster', 'warehouse', 'pipeline', 'table'],
        limit:
          'Counts are this estate in this window. A zero is only a fact about the platform where the ' +
          'columns are present and the read was not refused, which each probe states separately.',
        probes,
      },
      null,
      2
    )}\n`
  );
}

for (const relation of RELATIONS) {
  const { pairs, needs, resolves, diagnostic, ...declared } = relation;
  const probe = {
    ...declared,
    columns: null,
    reading: null,
    refusalToRead: null,
    endpoints: null,
    diagnostic: null,
  };

  try {
    probe.columns = await columnsPresent(needs);
    const missing = probe.columns.flatMap((one) => one.absent);

    if (missing.length > 0) {
      probe.reading = 'not readable on this workspace';
    } else {
      const [row] = await runStatement(counted(pairs), days, POLLS);
      probe.reading = Object.fromEntries(Object.entries(row ?? {}).map(([key, value]) => [key, Number(value)]));

      if (resolves != null) {
        const [ends] = await runStatement(resolves.sql, days, POLLS);
        probe.endpoints = {
          what: resolves.what,
          ends: Number(ends?.ends ?? 0),
          resolved: Number(ends?.ends_resolved ?? 0),
        };
      }

      if (diagnostic != null) {
        const [row] = await runStatement(diagnostic.sql, days, POLLS);
        probe.diagnostic = {
          what: diagnostic.what,
          ...Object.fromEntries(Object.entries(row ?? {}).map(([key, value]) => [key, Number(value)])),
        };
      }
    }
  } catch (cause) {
    probe.refusalToRead = String(cause?.message ?? cause).slice(0, 600);
  }

  probes.push(probe);
  record();

  const reading = probe.reading;
  console.log(
    `${probe.id.padEnd(20)} ${
      probe.refusalToRead != null
        ? `refused: ${probe.refusalToRead.slice(0, 80)}`
        : typeof reading === 'string'
          ? reading
          : `${String(reading.edges)} edges, ${String(reading.from_ends)} → ${String(reading.to_ends)} ends, ` +
            `${String(reading.rows_naming_both_ends)} of ${String(reading.rows_scanned)} rows name both` +
            (probe.endpoints == null
              ? ''
              : `, ${String(probe.endpoints.resolved)} of ${String(probe.endpoints.ends)} far ends resolve`)
    }`
  );
}

console.log(`\nwrote ${path}`);
