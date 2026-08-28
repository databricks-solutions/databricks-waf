// What a Genie and Unity Catalog readiness score could be built out of. Ledger row `45a`.
//
// The audit asks for this first and in those words — "measure available sources, cost and denominators
// before designing the score" — and this repository's own reason is stronger. `H1` measured its premise
// and found seven of eight statements did not need the rework planned for them; `41d` measured a table
// two rows had been written around and found the readings they rested on could not carry it. So `45b`
// and `45c` are designed after this runs, not before.
//
// Three questions, and the third is the one the phase exists because of.
//
//   1. **Which sources exist, and what do they carry?** A dimension can only be built on a relation that
//      answers. Each candidate is read once, and a refusal is kept as a refusal: on a shared estate a
//      `PERMISSION_DENIED` is the expected failure and it is indistinguishable from an empty table to a
//      script that catches errors, which is the apparatus error `41d` was written to correct.
//
//   2. **What does it cost?** Every probe is timed. A dimension whose source takes minutes on a wide
//      metastore is a dimension that has to be sampled or bounded, and that is a design decision `45c`
//      makes with a number rather than a guess.
//
//   3. **Where do the denominators disagree?** The four shipped statements each count "the tables" and
//      each count a different population — every relation, stored tables only, or the tables something
//      read in a window. A readiness outcome joins their answers, and joining two shares taken over two
//      populations produces a number whose only true property is that somebody computed it. This is
//      `41b`'s defect at estate scale: on an estate this size a wrong denominator still yields a
//      plausible figure, so nothing about the result says it is wrong.
//
// The whole script reads catalogue metadata, system tables and two REST list endpoints. No query text,
// no table contents, no sample rows.
//
// Run: cd app && DATABRICKS_HOST=... DATABRICKS_WAREHOUSE_ID=... DATABRICKS_CONFIG_PROFILE=large-estate \
//        node scripts/measure-serving-readiness-sources.mjs
//
// Writes `server/collect/sql/runtime-baseline/<profile>-serving-readiness-sources.json`. The estate is in
// the name and the two guards in `recording-guards.mjs` check the name is true.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { corpusSettings, fetchText, runStatement } from './plan-corpus.mjs';
import { refuseUnlessNamedForItsEstate } from './recording-guards.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINES = join(HERE, '..', 'server', 'collect', 'sql', 'runtime-baseline');
const OUT = join(BASELINES, `${corpusSettings.profile}-serving-readiness-sources.json`);
const STATEMENTS = join(HERE, '..', 'config', 'statements');

/**
 * The window the read-table denominator uses, which is the app's own default lookback.
 *
 * Quoted from the collector rather than chosen, because the reading below compares this denominator
 * against three others and a window this script picked would make the comparison about the window.
 */
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? 30);

/**
 * How many pages of Genie spaces to walk, and why there is a limit at all.
 *
 * The list endpoint pages and has no count, so the number of spaces is what a walk of it says. A page
 * measured at about seven hundred milliseconds, which makes a full walk of a demo estate affordable —
 * but a cap is still here because an endpoint that keeps issuing tokens would otherwise be an
 * unbounded probe on somebody else's workspace, and `complete` is what says whether the cap was hit.
 */
const SPACE_PAGES = Number(process.env.SPACE_PAGES ?? 50);
const SPACE_PAGE_SIZE = Number(process.env.SPACE_PAGE_SIZE ?? 100);

/**
 * Two-second polls a probe gets here, against the shared default of 150 — five minutes.
 *
 * Ninety minutes, because two of the readings this script exists to take are past five: the ABAC
 * definitions view answered in 16m34s and `uc_discovery_metadata` in 67m, and under the default both
 * come back `unfinished` with a null denominator beside them. That is a run that looks like a
 * measurement and is a reading of this constant. Fixed rather than overridable, which the rest of this
 * script's knobs are not: an environment that already carries `STATEMENT_POLLS` — the shell that took
 * the first reading did — would silently cap the two statements this row is about, and the cost figures
 * in `45a`'s write-up are the whole reason it was worth taking.
 */
const POLLS = 2700;

/**
 * Mirrors `queries.ts`'s `customerCatalogPredicate`, as three other measurement scripts mirror it.
 *
 * A copy because this file runs under plain Node and cannot import the app's TypeScript. The test
 * asserts it against the original rather than against a transcription.
 */
const FRAGMENT = /\{\{customer_catalog ([A-Za-z_][\w.]*)\}\}/g;
export function customerCatalog(text) {
  return text.replace(
    FRAGMENT,
    (_whole, column) =>
      `(${column} NOT IN (SELECT catalog_name FROM system.information_schema.catalogs ` +
      `WHERE catalog_owner = 'System user') AND lower(${column}) NOT IN ('system', 'samples')` +
      ` AND NOT startswith(lower(${column}), '__databricks_internal'))`
  );
}

/**
 * A shipped statement, as the app sends it.
 *
 * The three denominators this row compares belong to three statements this repository already runs, and
 * the first pass at them was a transcription: three probes written from reading the SQL. Two matched.
 * The third did not, and the way it failed is the failure this whole row exists to characterise —
 * `uc_discovery_metadata` counts *catalogued* tables something read, by left-joining reads onto the
 * census population, and the probe counted distinct lineage sources instead. That is a larger population
 * by the 8,731 relations lineage names and the catalogue does not, and the description share taken over
 * it was a correctly-computed figure about tables `DG-01-06` never scores.
 *
 * So the denominators are read from the statements rather than from a reading of them.
 * `measure-table-layout-inputs.mjs` loads `storage_sample_selection.sql` for the same reason: a mirror is
 * only as good as the moment it was written, and this one was wrong on the day.
 */
function shipped(name) {
  return customerCatalog(readFileSync(join(STATEMENTS, `${name}.sql`), 'utf8').replace(/;\s*$/, '').trim());
}

/**
 * A statement, timed, with a refusal kept rather than thrown.
 *
 * The same shape `measure-table-layout-inputs.mjs` uses and for the same reason: a probe that raised
 * and a probe that returned nothing are different findings about a source, and question 1 above is
 * exactly the difference between them.
 */
export async function probe(label, statement, parameters = []) {
  const started = Date.now();
  try {
    const rows = await runStatement(statement, parameters, POLLS);
    return { label, ok: true, ms: Date.now() - started, rows };
  } catch (error) {
    return { label, ok: false, ms: Date.now() - started, error: String(error).slice(0, 300) };
  }
}

/** One probe by its label, or null where it is absent — never a fabricated empty one. */
export function only(probes, label) {
  return probes.find((one) => one.label === label) ?? null;
}

/** A probe's first row, or null where the probe failed or returned nothing. */
export function firstRow(probes, label) {
  const found = only(probes, label);
  if (found?.ok !== true) return null;
  return found.rows[0] ?? null;
}

/**
 * A numeric field, or null where there is nothing to read.
 *
 * Null rather than zero throughout. A zero from a probe that failed is the number this script must
 * never produce: half of what it is measuring is whether an empty reading is the estate or the grant.
 */
export function count(row, key) {
  const value = row?.[key];
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * What a source amounts to, as one of five words rather than a row count.
 *
 * `written`, `empty`, `unread`, and two kinds of failure that a cost measurement may not merge.
 * `refused` is the grant saying no and is a coverage limit of this reading; `unfinished` is the source
 * still running when the poll budget ran out, which is a fact about the source and the most important
 * thing a dimension can be told about before it is designed around. Collapsing them would report a
 * seventeen-minute statement as a permission problem.
 *
 * A statement that ran out of polls comes back with its state still `RUNNING` or `PENDING` in the
 * error, which is what separates the two.
 */
export function verdict(found, rows) {
  if (found == null) return 'refused';
  if (found.ok !== true) return /"state":"(RUNNING|PENDING)"/.test(found.error ?? '') ? 'unfinished' : 'refused';
  if (rows == null) return 'unread';
  return rows > 0 ? 'written' : 'empty';
}

/**
 * Whether a field list carries one of a named set, by exact name rather than by substring.
 *
 * Exact because the first pass matched `/space/` and reported that an assistant event names a Genie
 * space. It does not: the field it matched was `workspace_id`. A substring search over identifiers is
 * a claim that the reader cannot check and that reads as measured, which is the defect this whole
 * phase is downstream of — and it produced a false positive on the one question the audit asks by
 * name, whether Genie usage is attributable.
 *
 * The names are recorded beside the answer so the next reader checks the set rather than trusting it.
 */
export function carries(fields, names) {
  if (fields == null) return null;
  const held = new Set(fields.map((field) => field.toLowerCase()));
  return names.some((name) => held.has(name));
}

/** What a Genie space would have to carry for the serving population to be read off the spaces. */
export const ASSET_FIELDS = ['table_identifiers', 'tables', 'datasets', 'curated_tables', 'data_assets'];

/** What an assistant event would have to carry to be attributed to a Genie space or an asset. */
export const SPACE_FIELDS = ['space_id', 'room_id', 'data_room_id', 'conversation_id'];
export const ASSET_EVENT_FIELDS = ['table_full_name', 'table_name', 'catalog_name', 'schema_name', 'asset_id'];
export const FEEDBACK_FIELDS = ['feedback', 'rating', 'thumbs_up', 'vote'];

/**
 * Every page of Genie spaces the walk was allowed, with what each cost.
 *
 * Paged rather than counted, because there is no count endpoint and the cost of the walk is half of
 * what this probe is for. A non-200 stops the walk and is kept: an endpoint this account cannot reach
 * is a coverage limit, and reporting it as zero spaces would be the same error as reporting a refused
 * table as an empty one.
 */
export async function walkSpaces(pages, pageSize) {
  const walked = [];
  let token = null;
  // The first space the walk sees, from whichever page carries one. Taking it from page zero would
  // report the shape of an empty page as the shape of a space.
  let keys = null;
  for (let page = 0; page < pages; page += 1) {
    const query = `page_size=${String(pageSize)}${token == null ? '' : `&page_token=${encodeURIComponent(token)}`}`;
    const started = Date.now();
    // Kept rather than thrown, like the non-200 below and for a longer reason: this walk runs after
    // every statement, and one of them costs an hour of a shared warehouse. A socket closing here
    // would otherwise take the whole recording with it and the hour would have to be spent again.
    let response = null;
    try {
      response = await fetchText(`/api/2.0/genie/spaces?${query}`);
    } catch (error) {
      walked.push({ page, ms: Date.now() - started, status: null, error: String(error).slice(0, 300) });
      return { walked, complete: false, spaces: null, keys };
    }
    const ms = Date.now() - started;
    if (response.status !== 200) {
      walked.push({ page, ms, status: response.status, error: response.text.slice(0, 300) });
      return { walked, complete: false, spaces: null, keys };
    }
    let body = null;
    try {
      body = JSON.parse(response.text);
    } catch {
      walked.push({ page, ms, status: response.status, error: 'the response was not JSON' });
      return { walked, complete: false, spaces: null, keys };
    }
    const spaces = Array.isArray(body.spaces) ? body.spaces : [];
    walked.push({ page, ms, status: 200, spaces: spaces.length });
    if (keys == null && spaces[0] != null) {
      keys = Object.keys(spaces[0]).sort();
      walked[page].keys = keys;
    }
    token = typeof body.next_page_token === 'string' && body.next_page_token !== '' ? body.next_page_token : null;
    if (token == null) {
      return {
        walked,
        complete: true,
        spaces: walked.reduce((sum, one) => sum + (one.spaces ?? 0), 0),
        keys,
      };
    }
  }
  // Ran out of allowed pages with a token still in hand. The count below is what was walked, not what
  // exists, and `complete: false` is what says so — a partial walk reported as a total is this file's
  // own version of the denominator error it exists to measure.
  return {
    walked,
    complete: false,
    spaces: walked.reduce((sum, one) => sum + (one.spaces ?? 0), 0),
    keys,
  };
}

/** One source's reading: does it answer, how much does it hold, and what did it cost. */
function source(probes, label, fields) {
  const found = only(probes, label);
  const row = firstRow(probes, label);
  const rows = count(row, 'rows');
  return {
    verdict: verdict(found, rows),
    ms: found?.ms ?? null,
    rows,
    ...Object.fromEntries(fields.map((field) => [field, count(row, field)])),
    ...(found?.ok === true ? {} : { error: found?.error ?? 'the probe was not run' }),
  };
}

async function main() {
  // Before the probes rather than after: a walk of a large shared estate that ends in a refusal to
  // write is minutes of somebody else's warehouse spent for nothing.
  refuseUnlessNamedForItsEstate(OUT, corpusSettings.profile, corpusSettings.host);

  const window = [{ name: 'lookback_days', value: String(LOOKBACK_DAYS), type: 'INT' }];
  // What the collector binds for a whole-account scan, which is the reach all three of these declare.
  const scan = [...window, { name: 'workspace_id', value: '', type: 'STRING' }];

  const probes = [
    // Question 3, answered by the three statements themselves. Each reports its own denominator and its
    // own described count, so the comparison below is between what the app computes rather than between
    // three readings of what it was thought to compute.
    await probe('uc_asset_census, as shipped', shipped('uc_asset_census')),
    await probe('uc_lineage_coverage, as shipped', shipped('uc_lineage_coverage'), scan),
    await probe('uc_discovery_metadata, as shipped', shipped('uc_discovery_metadata'), scan),
    // The catalogue by table type, which no shipped statement breaks out past `VIEW`: a governance
    // dimension over "every relation" is a dimension over whatever this says it is mostly made of.
    // One statement, so the counts are taken over one metastore at one moment.
    await probe(
      'the catalogue, by table type',
      customerCatalog(
        `SELECT count(*)                                                     AS rows,
                count_if(table_type IN ('MANAGED', 'EXTERNAL'))              AS stored_tables,
                count_if(table_type = 'VIEW')                                AS views,
                count_if(table_type = 'METRIC_VIEW')                         AS metric_views,
                count_if(table_type = 'FOREIGN')                             AS foreign_tables,
                count_if(table_type IN ('MATERIALIZED_VIEW', 'STREAMING_TABLE')) AS pipeline_outputs,
                count_if(comment IS NOT NULL AND length(trim(comment)) > 0)  AS described,
                count_if(table_type IN ('MANAGED', 'EXTERNAL')
                         AND comment IS NOT NULL AND length(trim(comment)) > 0) AS stored_and_described
           FROM system.information_schema.tables
          WHERE table_schema <> 'information_schema'
            AND {{customer_catalog table_catalog}}`
      )
    ),
    // What lineage names, against what the catalogue holds — the one figure `uc_discovery_metadata`
    // cannot report about its own population. That statement inner-joins reads onto the census, so a
    // table lineage saw and the catalogue does not list simply is not in its count; whether that is a
    // handful or a third of the read population is invisible from its output and decides whether
    // `45c` may treat the read population as a subset of the catalogued one.
    //
    // Window and null test copied from `uc_discovery_metadata` rather than chosen, so `not_in_the
    // _catalogue` is the difference between the two counts and not the difference between two windows.
    await probe(
      'what lineage names as a source',
      customerCatalog(
        `WITH read_tables AS (
           SELECT DISTINCT source_table_catalog AS c, source_table_schema AS s, source_table_name AS t
             FROM system.access.table_lineage
            WHERE event_date >= current_date() - make_dt_interval(:lookback_days)
              AND source_table_name IS NOT NULL
              AND {{customer_catalog source_table_catalog}}
         )
         SELECT count(*)                                                   AS rows,
                count_if(k.table_type IN ('MANAGED', 'EXTERNAL'))          AS stored_tables,
                count_if(k.table_type IS NULL)                             AS not_in_the_catalogue,
                count_if(k.table_type NOT IN ('MANAGED', 'EXTERNAL'))      AS other_types,
                count_if(k.comment IS NOT NULL AND length(trim(k.comment)) > 0) AS described
           FROM read_tables r
           LEFT JOIN system.information_schema.tables k
             ON k.table_catalog = r.c AND k.table_schema = r.s AND k.table_name = r.t
            AND k.table_schema <> 'information_schema'`
      ),
      window
    ),
    // Question 1, the tag sources. Four relations rather than one, because a governed serving tag could
    // be set at any level and a score reading only `table_tags` would report an estate tagged at the
    // schema as untagged. Distinct keys as well as rows: the audit asks for required tag keys, and how
    // many distinct keys an estate already carries decides whether that is a rule or a migration.
    await probe(
      'table tags',
      customerCatalog(
        `SELECT count(*)                                                                   AS rows,
                count(DISTINCT concat_ws('.', catalog_name, schema_name, table_name))      AS tagged_tables,
                count(DISTINCT tag_name)                                                   AS distinct_keys
           FROM system.information_schema.table_tags
          WHERE {{customer_catalog catalog_name}}`
      )
    ),
    await probe(
      'column tags',
      customerCatalog(
        `SELECT count(*)                                                                   AS rows,
                count(DISTINCT concat_ws('.', catalog_name, schema_name, table_name))      AS tagged_tables,
                count(DISTINCT tag_name)                                                   AS distinct_keys
           FROM system.information_schema.column_tags
          WHERE {{customer_catalog catalog_name}}`
      )
    ),
    await probe(
      'schema tags',
      customerCatalog(
        `SELECT count(*)                                              AS rows,
                count(DISTINCT concat_ws('.', catalog_name, schema_name)) AS tagged_schemas,
                count(DISTINCT tag_name)                              AS distinct_keys
           FROM system.information_schema.schema_tags
          WHERE {{customer_catalog catalog_name}}`
      )
    ),
    await probe(
      'catalog tags',
      customerCatalog(
        `SELECT count(*)                       AS rows,
                count(DISTINCT catalog_name)   AS tagged_catalogs,
                count(DISTINCT tag_name)       AS distinct_keys
           FROM system.information_schema.catalog_tags
          WHERE {{customer_catalog catalog_name}}`
      )
    ),
    // Question 1, the policy sources. The app counts masks and filters today and resolves neither, and
    // the audit's fourth point is that they apply where a classification policy requires them — so what
    // decides `45b` is whether the estate can say *which* assets a policy is required on. Distinct
    // tables as well as rows, because a table may carry several.
    // `table_catalog` and `table_schema` here, where every relation above uses `catalog_name`. The two
    // policy relations are keyed the other way round and the first pass of this script did not check:
    // both probes came back `UNRESOLVED_COLUMN`, which this file's own verdict function reads as
    // `refused`, and the recording would have said the estate declined a read it was never asked for.
    // `AGENTS.md` calls this measuring the apparatus; `docs/estates.md` records two earlier probes lost
    // to column names taken from prose rather than from `DESCRIBE`.
    await probe(
      'column masks',
      customerCatalog(
        `SELECT count(*)                                                              AS rows,
                count(DISTINCT concat_ws('.', table_catalog, table_schema, table_name)) AS masked_tables
           FROM system.information_schema.column_masks
          WHERE {{customer_catalog table_catalog}}`
      )
    ),
    await probe(
      'row filters',
      customerCatalog(
        `SELECT count(*)                                                              AS rows,
                count(DISTINCT concat_ws('.', table_catalog, table_schema, table_name)) AS filtered_tables
           FROM system.information_schema.row_filters
          WHERE {{customer_catalog table_catalog}}`
      )
    ),
    // The relation that would make "applies where policy requires it" answerable rather than assumed.
    // Unfiltered by catalog: a policy is defined on a securable that may be a catalog or a schema, so
    // the customer predicate would drop exactly the estate-wide ones.
    await probe(
      'ABAC policy definitions',
      `SELECT count(*)                          AS rows,
              count(DISTINCT policy_type)       AS policy_types,
              count(DISTINCT on_securable_type) AS securable_types,
              count_if(match_columns IS NOT NULL AND size(match_columns) > 0) AS with_match_columns,
              count_if(when_condition IS NOT NULL) AS with_a_condition
         FROM system.information_schema.abac_policy_definitions`
    ),
    // The classification the policy matrix would key off. `class_tag` per column with a confidence, so
    // whether an estate has any is what decides whether `45b`'s matrix has an input or a plan.
    await probe(
      'data classification results',
      customerCatalog(
        `SELECT count(*)                                                              AS rows,
                count(DISTINCT concat_ws('.', catalog_name, schema_name, table_name)) AS classified_tables,
                count(DISTINCT class_tag)                                             AS distinct_classes
           FROM system.data_classification.results
          WHERE {{customer_catalog catalog_name}}`
      )
    ),
    // Question 1, the quality and freshness source. The one relation here that carries a *status* the
    // platform computed rather than a number this app would threshold, which is the difference between
    // a dimension `45c` reports and one it invents.
    await probe(
      'data quality monitoring',
      customerCatalog(
        `SELECT count(*)                                                              AS rows,
                count(DISTINCT concat_ws('.', catalog_name, schema_name, table_name)) AS tables,
                count(DISTINCT status)                                                AS statuses,
                count_if(freshness.status IS NOT NULL)                                AS with_a_freshness_status
           FROM system.data_quality_monitoring.table_results
          WHERE event_time >= current_timestamp() - INTERVAL :lookback_days DAYS
            AND {{customer_catalog catalog_name}}`
      ),
      window
    ),
    // Question 1, the Genie usage source, and the audit's fifth point: attributable usage only when a
    // platform source proves it. The count is beside the point — what matters is the column list, read
    // below, which is what decides whether an event can be attributed to a space or an asset at all.
    await probe(
      'assistant events',
      `SELECT count(*)                        AS rows,
              count(DISTINCT workspace_id)    AS workspaces,
              count(DISTINCT initiated_by)    AS initiators,
              count(DISTINCT user_agent)      AS user_agents
         FROM system.access.assistant_events
        WHERE event_date >= current_date() - INTERVAL :lookback_days DAYS`,
      window
    ),
    await probe(
      'what an assistant event carries',
      `SELECT column_name, data_type
         FROM system.information_schema.columns
        WHERE table_catalog = 'system' AND table_schema = 'access' AND table_name = 'assistant_events'
        ORDER BY ordinal_position`
    ),
  ];

  const spaces = await walkSpaces(SPACE_PAGES, SPACE_PAGE_SIZE);

  const all = firstRow(probes, 'the catalogue, by table type');
  const lineage = firstRow(probes, 'what lineage names as a source');
  const census = firstRow(probes, 'uc_asset_census, as shipped');
  const coverage = firstRow(probes, 'uc_lineage_coverage, as shipped');
  const discovery = firstRow(probes, 'uc_discovery_metadata, as shipped');
  const events = only(probes, 'what an assistant event carries');
  const eventColumns = events?.ok === true ? events.rows.map((row) => String(row['column_name'])) : null;

  const reading = {
    runFinishedAt: new Date().toISOString(),
    profile: corpusSettings.profile,
    host: corpusSettings.host,
    warehouse: corpusSettings.warehouse,
    lookbackDays: LOOKBACK_DAYS,

    // Question 3, and the reason it is first: every share `45c` reports is a numerator over one of
    // these, and they differ by more than an order of magnitude on a wide metastore.
    //
    // Each figure comes from the statement that scores the control named beside it, so this is a
    // comparison between what the app computes rather than between three readings of what it was
    // thought to compute. The first pass took them from three probes written by reading the SQL, and
    // one of the three was a different population — which is the error the section is about, arrived
    // at while measuring it.
    denominators: {
      // `uc_asset_census`, scoring `DG-01-05`: every relation the catalogue lists.
      everyRelation: count(census, 'table_count'),
      // `uc_lineage_coverage`, scoring `DG-01-04`: `MANAGED` and `EXTERNAL` only, no views of any kind.
      storedTables: count(coverage, 'table_count'),
      // `uc_discovery_metadata`, scoring `DG-01-06`: catalogued tables something read in the window.
      // A left join onto the census population, so this is a subset of `everyRelation` by construction.
      readTables: count(discovery, 'read_tables'),
      described: {
        // One measure over three populations, stated as three figures rather than as one and a caveat —
        // ADR 0083's rule about incomparable readings, applied to a denominator.
        everyRelation: count(census, 'described_tables'),
        // No shipped statement reports descriptions over the stored population; the census counts them
        // over every relation and the coverage statement counts no descriptions at all. This is the one
        // figure here taken from a probe of this script's own, which is why it is named as such.
        storedTables: count(all, 'stored_and_described'),
        readTables: count(discovery, 'read_tables_described'),
      },
      // What lineage saw, which is not what `uc_discovery_metadata` counts: it inner-joins reads onto
      // the catalogue, so anything lineage names and the catalogue does not list falls out silently.
      // The gap is the reason `45c` may not treat the read population as nested inside the catalogued
      // one, and no shipped statement can report it.
      lineageNames: count(lineage, 'rows'),
      readButNotCatalogued: count(lineage, 'not_in_the_catalogue'),
      byType: {
        views: count(all, 'views'),
        metricViews: count(all, 'metric_views'),
        foreign: count(all, 'foreign_tables'),
        pipelineOutputs: count(all, 'pipeline_outputs'),
      },
    },

    // Question 1, one entry per candidate, each carrying its own verdict rather than a row count a
    // later reader has to interpret.
    sources: {
      tableTags: source(probes, 'table tags', ['tagged_tables', 'distinct_keys']),
      columnTags: source(probes, 'column tags', ['tagged_tables', 'distinct_keys']),
      schemaTags: source(probes, 'schema tags', ['tagged_schemas', 'distinct_keys']),
      catalogTags: source(probes, 'catalog tags', ['tagged_catalogs', 'distinct_keys']),
      columnMasks: source(probes, 'column masks', ['masked_tables']),
      rowFilters: source(probes, 'row filters', ['filtered_tables']),
      abacPolicies: source(probes, 'ABAC policy definitions', [
        'policy_types',
        'securable_types',
        'with_match_columns',
        'with_a_condition',
      ]),
      classification: source(probes, 'data classification results', ['classified_tables', 'distinct_classes']),
      qualityMonitoring: source(probes, 'data quality monitoring', ['tables', 'statuses', 'with_a_freshness_status']),
      assistantEvents: source(probes, 'assistant events', ['workspaces', 'initiators', 'user_agents']),
    },

    // The semantic-asset population, from the two places it could come from. Metric views are a
    // `table_type` and so are already inside the description denominator above; Genie spaces are a REST
    // list and are not in the catalogue at all.
    semanticAssets: {
      metricViews: count(all, 'metric_views'),
      genieSpaces: {
        walked: spaces.spaces,
        complete: spaces.complete,
        pages: spaces.walked,
        // What a space carries, which decides whether the serving population can be read off the spaces.
        // If a space named its tables there would be no need for a governed tag, and the audit's second
        // point would be a preference rather than the only option.
        fields: spaces.keys,
        namesItsAssets: carries(spaces.keys, ASSET_FIELDS),
        lookedFor: ASSET_FIELDS,
      },
    },

    // The audit's fifth point, answered by a column list rather than by a row count. An event with no
    // space, no conversation and no asset on it cannot be attributed to either, however many there are.
    genieAttribution: {
      columns: eventColumns,
      namesASpace: carries(eventColumns, SPACE_FIELDS),
      namesAnAsset: carries(eventColumns, ASSET_EVENT_FIELDS),
      carriesFeedback: carries(eventColumns, FEEDBACK_FIELDS),
      lookedFor: { space: SPACE_FIELDS, asset: ASSET_EVENT_FIELDS, feedback: FEEDBACK_FIELDS },
    },

    // Question 2, gathered in one place because it is what `45c` sizes its collection against.
    cost: Object.fromEntries(probes.map((one) => [one.label, one.ms])),

    probes,
  };

  writeFileSync(OUT, `${JSON.stringify(reading, null, 2)}\n`);
  process.stdout.write(
    [
      `estate: ${reading.profile} at ${reading.host}`,
      `denominators: ${String(reading.denominators.everyRelation)} relations, ` +
        `${String(reading.denominators.storedTables)} stored, ${String(reading.denominators.readTables)} read in ` +
        `${String(LOOKBACK_DAYS)} days`,
      `lineage names ${String(reading.denominators.lineageNames)} sources, of which ` +
        `${String(reading.denominators.readButNotCatalogued)} are not catalogued`,
      `described: ${String(reading.denominators.described.everyRelation)} of every relation, ` +
        `${String(reading.denominators.described.storedTables)} of stored, ` +
        `${String(reading.denominators.described.readTables)} of read`,
      ...Object.entries(reading.sources).map(
        ([name, one]) => `source ${name}: ${one.verdict} — ${String(one.rows)} rows in ${String(one.ms)}ms`
      ),
      `genie spaces: ${String(reading.semanticAssets.genieSpaces.walked)} walked over ` +
        `${String(reading.semanticAssets.genieSpaces.pages.length)} pages, complete=${String(reading.semanticAssets.genieSpaces.complete)}, ` +
        `names its assets=${String(reading.semanticAssets.genieSpaces.namesItsAssets)}`,
      `genie attribution: space=${String(reading.genieAttribution.namesASpace)}, ` +
        `asset=${String(reading.genieAttribution.namesAnAsset)}, feedback=${String(reading.genieAttribution.carriesFeedback)}`,
      ...probes.map((one) => `probe ${one.label}: ${one.ok ? `${String(one.rows.length)} rows` : `FAILED ${one.error}`}`),
      `written to ${OUT}`,
      '',
    ].join('\n')
  );
}

// Guarded so a test can import the readers without running a scan, which is every measurement script's shape.
if (process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
