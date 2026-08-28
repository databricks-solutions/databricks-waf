// Turning three statement results into a readiness outcome, in two passes.
//
// The passes are not an optimisation. `45a` measured what a statement costs when it reads the whole
// catalogue on a real estate — `uc_discovery_metadata`, sixty-seven minutes over 495,558 relations,
// which is [61](../../../docs/plan/61-discovery-statement-cost.md) — and every statement here is
// bounded to the relations somebody declared instead. That bound only exists once the declaration has
// been resolved against the catalogue, which is what the first pass does: it reads the candidates the
// declaration could select, `serving-asset.ts` decides which of them it does select, and the second
// pass reads facts for exactly those.
//
// So the division of labour is deliberate and it is the same one `45b` argued for. SQL finds
// candidates; TypeScript decides membership. A rule expressed in SQL is a rule nobody can write an
// adversarial test against, and the rule here — that a name classifies nothing — is the one the whole
// definition exists to hold.
//
// Every statement can fail on its own, and each failure is reported as an unread statement rather than
// as an empty result. That distinction is the module's whole reason for being careful: an estate with
// no masks and an estate whose masks nobody could read produce the same empty list, and the readiness
// outcome says `unmeasured` for the second only if this file hands it a null rather than a `[]`.

import type {
  AssetName,
  CataloguedAsset,
  ClassificationFact,
  ProtectionFact,
  ServingDefinition,
  ServingEvidence,
  TagFact,
  TagLevel,
} from './serving-asset.js';
import { qualify, servingPopulation } from './serving-asset.js';
import type { AssetFacts, ReadinessOutcome } from './readiness.js';
import { readiness } from './readiness.js';
import type {
  ServingClassRows,
  ServingFactRows,
  ServingPopulationRows,
  ServingQualityRows,
  ServingTagRows,
} from '../collect/sql/shapes.js';

/**
 * The five statements, as the caller can run them.
 *
 * A port rather than a collector, because the two callers want different things from the same
 * statements: the route runs them against the customer's warehouse, and the tests run them against
 * rows written by hand. Each may reject, and a rejection is the statement being unreadable.
 */
export interface ServingSql {
  /** Pass one: the candidates the declaration could select, by name and by tag key. */
  population(names: string, tagKeys: string): Promise<ServingPopulationRows>;
  /** Pass two, over the population pass one produced. */
  tags(assets: string): Promise<ServingTagRows>;
  facts(assets: string): Promise<ServingFactRows>;
  /**
   * The two reads whose system schemas are enabled per metastore and absent by default.
   *
   * Separate methods because they are separate statements, and separate statements because an absent
   * schema fails one at parse time: while these were CTEs inside `facts`, a metastore without them
   * returned nothing for the six dimensions that do not read them. Row 65, ADR 0088.
   */
  quality(assets: string): Promise<ServingQualityRows>;
  classes(assets: string): Promise<ServingClassRows>;
}

/**
 * A statement whose answer this outcome cannot read from, and what happened. Rendered beside it.
 *
 * `kind` is on the wire because the two are not the same news. A statement that rejected is a grant
 * the app does not hold; a statement that answered and stopped at its ceiling read the estate fine and
 * read too much of it. Told only that something "did not answer", a reader would go looking for a
 * permission that is not missing.
 */
export interface UnreadStatement {
  readonly statement:
    | 'sql:serving.population'
    | 'sql:serving.tags'
    | 'sql:serving.facts'
    | 'sql:serving.quality'
    | 'sql:serving.classes';
  readonly kind: 'failed' | 'capped';
  readonly because: string;
}

export interface ReadinessReading {
  readonly outcome: ReadinessOutcome;
  /** Empty where all three answered. Never inferred from an empty result. */
  readonly unread: readonly UnreadStatement[];
}

/** The evidence an undeclared estate has, which is none of it, and no statement was run to find out. */
const NOTHING: ServingEvidence = { catalogued: null, tags: null, classifications: null, protections: null };

/**
 * The one protection this read does not look for, declared rather than left to be inferred.
 *
 * `serving_asset_facts` reads masks and filters off `information_schema`, which answers in a second on
 * a bounded population. It does not read `abac_policy_definitions`: `45a` measured that at 720 rows in
 * sixteen and a half minutes, against one to eleven seconds for every other source it timed. Saying so
 * here rather than omitting it is what stops a matrix requiring an ABAC policy from reporting every
 * classified table as unprotected — `policyReadings` reads this and returns unmeasured instead.
 */
const UNREAD_PROTECTIONS = ['abac-policy'] as const;

/**
 * A readiness outcome for a declaration, or the undeclared one where there is nothing to read.
 *
 * The undeclared case runs no statement at all. That is worth being explicit about because the
 * alternative — running the population statement with an empty name list and an empty key list — would
 * charge the customer's warehouse for a question nobody asked and return an empty population that
 * every share divides by.
 */
export async function readReadiness(
  definition: ServingDefinition | null,
  sql: ServingSql,
): Promise<ReadinessReading> {
  if (definition == null) {
    return { outcome: readiness(null, { serving: NOTHING, facts: null }), unread: [] };
  }

  const unread: UnreadStatement[] = [];

  const first = await attempt(
    () => sql.population(definition.named.map(qualify).join(','), definition.tagged.map((one) => one.key).join(',')),
    'sql:serving.population',
    unread,
  );

  if (first == null) {
    // Nothing else can run: the second pass is bound to the population this one finds, and running it
    // unbound is the estate-wide read this module exists to avoid. Every dimension is unmeasured, and
    // the reason the outcome gives is that the catalogue was not read — which is what happened.
    return { outcome: readiness(definition, { serving: NOTHING, facts: null }), unread };
  }

  const selecting: ServingEvidence = {
    catalogued: first.matches.map(catalogued),
    tags: first.matches.flatMap(selectedBy),
    classifications: null,
    protections: null,
  };
  const population = servingPopulation(definition, selecting);
  const assets = population.assets.map((asset) => asset.qualified).join(',');

  if (population.assets.length === 0) {
    // A declaration that selected nothing the catalogue holds. The second pass would be two statements
    // bound to an empty list, which is a warehouse charged for two answers nobody can use: every
    // dimension is already reported as having no population, with that as its reason.
    return { outcome: readiness(definition, { serving: selecting, facts: [], population }), unread };
  }

  // Every statement of the second pass, each attempted on its own, and a failure in one costing only
  // the dimensions it feeds. That is the whole of row 65: quality and classification read two system
  // schemas an account admin enables per metastore, they were CTEs inside the facts statement, and an
  // absent schema fails a statement at parse time — so on a metastore with neither enabled, which is
  // the calibration estate, this read returned two of eight dimensions instead of six of eight.
  const [tags, facts, quality, classes] = await Promise.all([
    attempt(() => sql.tags(assets), 'sql:serving.tags', unread),
    attempt(() => sql.facts(assets), 'sql:serving.facts', unread),
    attempt(() => sql.quality(assets), 'sql:serving.quality', unread),
    attempt(() => sql.classes(assets), 'sql:serving.classes', unread),
  ]);

  // A tag read that stopped at its cap is unread rather than partial, which the two caps either side of
  // it are not. A missing fact leaves an asset out of `facts` and so unmeasured; a missing *tag* row is
  // indistinguishable from the asset not carrying the key, and the only reading that follows from not
  // carrying a required key is `short`. So a cap here would report an asset as failing a requirement on
  // the strength of a row that never arrived, which is what `serving_asset_tags.sql` says it must not.
  // Whole-list rather than per-asset: the statement orders by name, so the cut falls inside one asset's
  // rows, and the app cannot tell which of the returned assets is that one.
  const complete = tags == null || tags.tagPopulation <= tags.tags.length;
  if (tags != null && !complete) {
    unread.push({
      statement: 'sql:serving.tags',
      kind: 'capped',
      because:
        `the tag read stopped at its ceiling: ${String(tags.tags.length)} rows returned of ` +
        `${String(tags.tagPopulation)} on the declared population, so which required keys an asset ` +
        `carries cannot be read from it.`,
    });
  }
  const read = complete ? tags : null;

  // The same cap argument as the tag read's, and it applies to both of the split reads for the same
  // reason: an asset cut from either result is indistinguishable from an asset the platform holds
  // nothing for, and "holds nothing" is a finding in both cases — an unmet quality dimension and an
  // unclassified asset. So a cut result is not read at all rather than read as far as it goes.
  const wholeQuality = quality == null || quality.qualityPopulation <= quality.statuses.length;
  if (quality != null && !wholeQuality) {
    unread.push({
      statement: 'sql:serving.quality',
      kind: 'capped',
      because:
        `the quality read stopped at its ceiling: ${String(quality.statuses.length)} rows returned of ` +
        `${String(quality.qualityPopulation)} on the declared population, so which assets the platform ` +
        `has recorded a status for cannot be read from it.`,
    });
  }
  const statuses = wholeQuality ? quality : null;

  const wholeClasses = classes == null || classes.classPopulation <= classes.classified.length;
  if (classes != null && !wholeClasses) {
    unread.push({
      statement: 'sql:serving.classes',
      kind: 'capped',
      because:
        `the classification read stopped at its ceiling: ${String(classes.classified.length)} rows ` +
        `returned of ${String(classes.classPopulation)} on the declared population, so which assets ` +
        `carry a classification cannot be read from it.`,
    });
  }
  const classified = wholeClasses ? classes : null;

  // Names are taken from the population rather than split back out of the qualified string the second
  // pass returns. Splitting is the one operation `45b` refuses anywhere near a definition: a name is
  // three fields, and a three-part string is only three fields until an identifier contains a dot.
  const named = new Map(population.assets.map((asset) => [asset.qualified, asset.name]));

  const evidence: ServingEvidence = {
    catalogued: selecting.catalogued,
    // The tags that selected the population *and* every table tag on it, because the two answer
    // different questions — which assets are served, and which of the required keys they carry. Null
    // where the second read failed or was capped, which reads as unmeasured rather than as an asset
    // with no tags.
    tags: read == null ? null : [...(selecting.tags ?? []), ...read.tags.flatMap((row) => tagged(row, named))],
    classifications:
      classified == null ? null : classified.classified.flatMap((row) => classifications(row, named)),
    protections: facts == null ? null : facts.assets.flatMap((row) => protections(row, named)),
    unreadProtections: UNREAD_PROTECTIONS,
  };

  return {
    outcome: readiness(definition, {
      serving: evidence,
      facts: facts == null ? null : facts.assets.map((row) => assetFacts(row, statuses)),
      // Either read whose cap cuts *assets* makes every reading below a reading of part of the declared
      // population. Reported once, on the outcome, rather than per dimension: the shares are all shares
      // of the same part. The tag cap is not one of these — it is reported as an unread statement above,
      // and a share over part of the population is not what it produces.
      truncated:
        first.matchPopulation > first.matches.length ||
        (facts != null && facts.assetPopulation > facts.assets.length),
      population,
    }),
    unread,
  };
}

async function attempt<T>(
  run: () => Promise<T>,
  statement: UnreadStatement['statement'],
  unread: UnreadStatement[],
): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    unread.push({ statement, kind: 'failed', because: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** A qualified name back into its three parts. The only place this happens, and it is the SQL's own. */
function nameOf(row: { readonly catalog: string; readonly schema: string; readonly table: string }): AssetName {
  return { catalog: row.catalog, schema: row.schema, table: row.table };
}

function catalogued(row: ServingPopulationRows['matches'][number]): CataloguedAsset {
  // `null` is the platform holding no description; `undefined` would be the read not carrying the
  // column. The statement selects both columns on every row, so these are always the platform's answer.
  return { name: nameOf(row), description: row.description, owner: row.owner };
}

const LEVELS: Readonly<Record<string, TagLevel>> = { catalog: 'catalog', schema: 'schema', table: 'table' };

function selectedBy(row: ServingPopulationRows['matches'][number]): readonly TagFact[] {
  if (row.tagKey == null || row.tagValue == null) return [];
  const level = LEVELS[(row.tagLevel ?? '').toLowerCase()];
  // A level the statement does not spell is dropped rather than guessed at. Guessing `table` would
  // put a catalog tag on a table, which is the one mistake that turns a tag on somebody else's catalog
  // into a required key this asset is short of.
  if (level == null) return [];
  const name = nameOf(row);
  if (level === 'catalog') return [{ on: { level, catalog: name.catalog }, key: row.tagKey, value: row.tagValue }];
  if (level === 'schema') {
    return [{ on: { level, catalog: name.catalog, schema: name.schema }, key: row.tagKey, value: row.tagValue }];
  }
  return [{ on: { level, ...name }, key: row.tagKey, value: row.tagValue }];
}

type Named = ReadonlyMap<string, AssetName>;

function tagged(row: ServingTagRows['tags'][number], named: Named): readonly TagFact[] {
  const on = named.get(row.qualified);
  // A row for an asset the population does not hold is dropped. It can only arrive from a statement
  // bound to a different list than the one this outcome is over, and a tag credited to an asset that
  // is not being reported is a required key silently satisfied by somebody else's table.
  if (on == null) return [];
  return [{ on: { level: 'table', ...on }, key: row.key, value: row.value }];
}

function classifications(row: ServingClassRows['classified'][number], named: Named): readonly ClassificationFact[] {
  const on = named.get(row.qualified);
  if (on == null) return [];
  return row.classifications.map((classification) => ({ on, classification }));
}

function protections(row: ServingFactRows['assets'][number], named: Named): readonly ProtectionFact[] {
  const on = named.get(row.qualified);
  if (on == null) return [];
  const held: ProtectionFact[] = [];
  if (row.maskedColumns > 0) held.push({ on, protection: 'column-mask' });
  if (row.rowFilters > 0) held.push({ on, protection: 'row-filter' });
  // No `abac-policy` fact, ever, from this read. `abac_policy_definitions` took sixteen and a half
  // minutes to return 720 rows on the measurement estate, so nothing here reads it; a definition whose
  // matrix requires one will read `short` on that protection, which is the honest answer to "this app
  // cannot see your ABAC policies" only because the surface says so beside the dimension.
  return held;
}

/**
 * One asset's facts, with the quality status folded in from the read that now carries it.
 *
 * The status is *omitted* rather than set to null when that read did not answer, and the difference is
 * the whole reason the field is optional: `readiness.ts` reads an absent `qualityStatus` as the
 * dimension being unmeasured and a null one as the platform holding no status, which is a failing
 * dimension. Before row 65 the two could not be told apart, because a metastore without
 * `system.data_quality_monitoring` failed the statement that carried all eight dimensions and the
 * question never arose.
 */
function assetFacts(row: ServingFactRows['assets'][number], statuses: ServingQualityRows | null): AssetFacts {
  const facts: AssetFacts = {
    qualified: row.qualified,
    kind: row.relationKind,
    format: row.storageFormat,
    columns: row.columnCount,
    commentedColumns: row.commentedColumns,
    lineageEvents: row.lineageEvents,
    semanticReaders: row.semanticReaders,
  };
  if (statuses == null) return facts;
  const held = statuses.statuses.find((one) => one.qualified === row.qualified);
  return { ...facts, qualityStatus: held?.qualityStatus ?? null };
}
