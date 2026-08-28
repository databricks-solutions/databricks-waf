// Where in the estate a gap is concentrated.
//
// The estate census answers how much; this answers where. The distinction is the
// difference between a statistic and a task: "103 of 347 tables carry no description" is
// something to feel bad about, and "68 of them are in four schemas" is something to do on
// a Tuesday afternoon.
//
// Read as an enrichment throughout. Every caller already has a finding without it, so an
// unreadable or truncated per-schema census costs a sentence rather than a control.

import type { SignalId } from '../../collect/signal.js';
import type { AssetCensus, SchemaCensus, SchemaCensusRow } from '../../collect/sql/shapes.js';
import { observedValue, type Observation } from './helpers.js';

export const SCHEMA_CENSUS: SignalId = 'sql:uc.schema_census';

/**
 * What the census left out of the estate, or nothing when it left nothing out.
 *
 * Stated on every finding derived from the census, because the denominator is the part of a
 * score people argue with. A user who counts `system.information_schema.tables` themselves
 * and gets a bigger number than the app reports needs to find the reason in the finding, not
 * in the source.
 */
export function estateExclusion(census: AssetCensus): string | undefined {
  if (census.databricksOwnedTables === 0) return undefined;
  const where = census.databricksOwnedCatalogs === '' ? '' : ` (${census.databricksOwnedCatalogs})`;
  return (
    `${String(census.databricksOwnedTables)} further tables sit in Databricks-owned catalogs${where} and are ` +
    'not assessed: they are provisioned and owned by Databricks, read-only, and present in every workspace'
  );
}

/** How many schemas to name. Beyond a handful the list stops being a list of places to go. */
const NAMED = 4;
const NAMED_TEXT = String(NAMED);

/**
 * Names where a gap sits, or nothing when it cannot be located.
 *
 * `gapOf` returns the count of the thing missing in that schema — undescribed tables,
 * non-Delta tables, whatever the control is about. Schemas with no gap are dropped rather
 * than listed with a zero, since the point is where to go.
 *
 * The sentence states its own limits: it says what share of the located gap the named
 * schemas hold, and when the census itself was truncated it says the concentration is of
 * the schemas examined rather than of the estate. Both matter because the natural reading
 * of a short list is "and that is all of it".
 */
export function whereTheGapIs(context: Observation, gapOf: (schema: SchemaCensusRow) => number): string | undefined {
  const census = observedValue<SchemaCensus>(context, SCHEMA_CENSUS);
  if (census == null || census.schemas.length === 0) return undefined;

  const withGap = census.schemas
    .map((schema) => ({ schema, gap: gapOf(schema) }))
    .filter((entry) => entry.gap > 0)
    .sort((a, b) => b.gap - a.gap || name(a.schema).localeCompare(name(b.schema)));

  if (withGap.length === 0) return undefined;

  const located = withGap.reduce((total, entry) => total + entry.gap, 0);
  const named = withGap.slice(0, NAMED);
  const held = named.reduce((total, entry) => total + entry.gap, 0);
  const listed = named.map((entry) => `${name(entry.schema)} (${String(entry.gap)})`).join(', ');

  const sentence =
    withGap.length <= NAMED
      ? `All ${String(located)} sit in ${count(withGap.length, 'schema', 'schemas')}: ${listed}`
      : `${String(held)} of the ${String(located)} sit in ${NAMED_TEXT} of ${count(withGap.length, 'schema', 'schemas')}: ${listed}`;

  const truncated = census.schemas.length < census.schemaPopulation;
  return truncated
    ? `${sentence}. Counted across the ${String(census.schemas.length)} largest of ${String(census.schemaPopulation)} schemas, so smaller schemas are not included`
    : sentence;
}

function name(schema: SchemaCensusRow): string {
  return `${schema.catalog}.${schema.schema}`;
}

function count(value: number, singular: string, plural: string): string {
  return `${String(value)} ${value === 1 ? singular : plural}`;
}
