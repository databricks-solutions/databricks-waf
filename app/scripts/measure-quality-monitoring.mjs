// What `system.data_quality_monitoring.table_results` can actually tell DG-03-02. Row `78`.
//
// `37j` was re-scoped on 2026-08-12 onto this table, on the strength of one probe: 12,572 results over
// 11,718 tables in 370 catalogs in seven days on `large-estate`, "with separate freshness and
// completeness verdicts". That is a real reading and it is not enough to design a resolver from. It
// says the table has rows; it does not say what share of an estate they cover, what the statuses mean
// as a population, or whether the two sub-verdicts distinguish anything.
//
// `AGENTS.md`: a phase that exists because of a number gets that number measured before the rework,
// because the measurement decides what the rework is. Here it decided two things `37j` had not
// anticipated, both in the recording and both in `docs/plan/78-what-the-quality-monitor-reports.md`.
//
// **This cannot be run on labs.** The schema is enabled per metastore by an account admin and labs has
// not enabled it — that is why `serving_asset_quality` is on the awaiting-reading list. So the reading
// is `large-estate`'s, which `docs/estates.md` has as large, shared and for measurement only, and the
// threshold question that follows from it is the part this row hands back rather than answers.
//
// Reads catalogue metadata and monitoring verdicts. No query text, no table contents, no sample rows.
//
// Run: cd app && DATABRICKS_HOST=... DATABRICKS_WAREHOUSE_ID=... DATABRICKS_CONFIG_PROFILE=large-estate \
//        node scripts/measure-quality-monitoring.mjs
//
// Writes `server/collect/sql/runtime-baseline/<profile>-quality-monitoring.json`.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { corpusSettings, runStatement } from './plan-corpus.mjs';
import { refuseUnlessNamedForItsEstate } from './recording-guards.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINES = join(HERE, '..', 'server', 'collect', 'sql', 'runtime-baseline');
const OUT = join(BASELINES, `${corpusSettings.profile}-quality-monitoring.json`);

const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? 30);

/**
 * The customer-catalog predicate `queries.ts` owns, written here because this is a probe and not a
 * shipped statement.
 *
 * Two copies already exist — `queries.ts` and `measure-sql-baseline.mjs` — and a third is worth naming
 * rather than hiding: what makes it tolerable is that nothing this file produces is executed by the
 * app, and what makes it necessary is that the denominator has to be the same population the shipped
 * statements count or the share below is not comparable to any of them.
 */
const CUSTOMER_CATALOG = (column) =>
  `(${column} NOT IN (SELECT catalog_name FROM system.information_schema.catalogs ` +
  `WHERE catalog_owner = 'System user') AND lower(${column}) NOT IN ('system', 'samples')` +
  ` AND NOT startswith(lower(${column}), '__databricks_internal'))`;

/** The estate the share is taken over: the customer's tables, views excluded as elsewhere. */
const ESTATE = `
SELECT count(*) AS estate_tables, count(DISTINCT table_catalog) AS estate_catalogs
FROM system.information_schema.tables
WHERE ${CUSTOMER_CATALOG('table_catalog')}
  AND table_type <> 'VIEW'`;

/**
 * One row per monitored table, reduced to its latest verdict, then counted.
 *
 * `max_by` over the window rather than a count of results, for `serving_asset_quality`'s reason: the
 * question is what the platform last said about a table, and a table with 30 daily results is not
 * thirty times as monitored as one with a single result.
 */
const MONITORED = `
WITH latest AS (
  SELECT
    concat_ws('.', catalog_name, schema_name, table_name) AS qualified,
    catalog_name,
    max_by(status, event_time)              AS status,
    max_by(freshness.status, event_time)    AS freshness_status,
    max_by(completeness.status, event_time) AS completeness_status
  FROM system.data_quality_monitoring.table_results
  WHERE event_time >= current_timestamp() - make_dt_interval(:lookback_days)
    AND ${CUSTOMER_CATALOG('catalog_name')}
  GROUP BY ALL
)
SELECT
  count(*)                                             AS monitored_tables,
  count(DISTINCT catalog_name)                         AS monitored_catalogs,
  count_if(status = 'Healthy')                         AS healthy,
  count_if(status = 'Unhealthy')                       AS unhealthy,
  count_if(status = 'Training')                        AS training,
  count_if(status = 'Error')                           AS errored,
  count_if(status NOT IN ('Healthy','Unhealthy','Training','Error')) AS unnamed_status,
  count_if(freshness_status IS NOT NULL)               AS freshness_present,
  count_if(completeness_status IS NOT NULL)            AS completeness_present,
  count_if(freshness_status <> 'Unknown')              AS freshness_established,
  count_if(completeness_status <> 'Unknown')           AS completeness_established
FROM latest`;

/** Every status triple the window holds, so the domain is what was seen and not what was assumed. */
const DOMAIN = `
SELECT status, freshness.status AS freshness_status, completeness.status AS completeness_status, count(*) AS results
FROM system.data_quality_monitoring.table_results
WHERE event_time >= current_timestamp() - make_dt_interval(:lookback_days)
  AND ${CUSTOMER_CATALOG('catalog_name')}
GROUP BY ALL
ORDER BY results DESC`;

const days = [{ name: 'lookback_days', value: String(LOOKBACK_DAYS), type: 'INT' }];

refuseUnlessNamedForItsEstate(OUT, corpusSettings.profile, corpusSettings.host);

console.log(`counting the estate on ${corpusSettings.host}...`);
const [estate] = await runStatement(ESTATE);
console.log(`  ${estate.estate_tables} tables in ${estate.estate_catalogs} customer catalogs`);

console.log(`reading the monitor over ${String(LOOKBACK_DAYS)} days...`);
const [monitored] = await runStatement(MONITORED, days);
console.log(`  ${monitored.monitored_tables} monitored tables in ${monitored.monitored_catalogs} catalogs`);

console.log('reading the status domain...');
const domain = await runStatement(DOMAIN, days);
console.log(`  ${String(domain.length)} distinct status triples`);

const numbers = Object.fromEntries(
  Object.entries({ ...estate, ...monitored }).map(([key, value]) => [key, Number(value)])
);

writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      what: 'What system.data_quality_monitoring.table_results reports over one estate, for row 78.',
      measuredAt: new Date().toISOString(),
      profile: corpusSettings.profile,
      host: corpusSettings.host,
      warehouseId: corpusSettings.warehouse,
      lookbackDays: LOOKBACK_DAYS,
      ...numbers,
      monitoredShare: numbers.estate_tables === 0 ? null : numbers.monitored_tables / numbers.estate_tables,
      // What was seen, not the field's documented domain. `37j` recorded four statuses from a seven-day
      // window and that is a reading of a window rather than of the platform, which is ADR 0074 applied
      // to our own measurements — so the triples are carried whole and the resolver reads none of them
      // as exhaustive.
      statusTriples: domain.map((row) => ({
        status: row.status,
        freshness: row.freshness_status,
        completeness: row.completeness_status,
        results: Number(row.results),
      })),
    },
    null,
    2
  )}\n`
);

console.log(`\nWrote ${OUT.slice(OUT.indexOf('app/'))}.`);
