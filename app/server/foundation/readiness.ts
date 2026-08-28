// Whether the data a customer declared they serve is ready to be served, dimension by dimension.
//
// [`serving-asset.ts`](serving-asset.ts) says which tables those are and what they owe. This says how
// far along each obligation the estate is, as eight separate readings rather than one number, and it is
// the eight rather than the one that is the point. `45a` measured the same description measure at
// **13.5% over every relation and 34.1% over the tables read in thirty days** on one estate, from two
// statements this app already ships, both correctly computed. A readiness score that adds readings
// taken over different populations produces a figure whose only true property is that somebody
// computed it, so **every dimension here states its denominator** and none of them are summed.
//
// Three things this module will not do, each because something measured says it cannot:
//
//   * **There is no Genie usage dimension.** `system.access.assistant_events` carries seven columns and
//     not one names a space, a conversation, an asset or a feedback signal, and a complete walk of
//     4,181 Genie spaces returns a title, a description, a warehouse and two timestamps. So no platform
//     source attributes a Genie event to a table, and the absence is reported as an absence rather than
//     filled with a proxy. It is in `absences()` below so a reader is told, rather than left to notice.
//   * **Nothing reads `abac_policy_definitions`.** It returned 720 rows in sixteen and a half minutes
//     against 1.2 to 11 seconds for every other source measured. What the policy dimension reads is the
//     protections the platform records against a table — masks and filters — which is the same question
//     asked of a relation that answers it in a second.
//   * **The performance dimension is a storage-format reading and is named after the field.** No source
//     measured attributes a query's cost or its latency to a table, so this reports what
//     `data_source_format` says and nothing about how anything will run.
//
// A dimension whose evidence was not read is `unmeasured`, never a failure and never a zero. That is
// the audit's wording and it is also the difference between the two states `45a` had to separate to
// report anything at all: an estate with no masks and an estate whose masks nobody could read produce
// the same empty list and opposite readings.

import type {
  MetadataReading,
  PolicyReading,
  ServingDefinition,
  ServingEvidence,
  ServingPopulation,
} from './serving-asset.js';
import { metadataReadings, policyReadings, servingPopulation } from './serving-asset.js';
import type { Digest } from '../records/digest.js';

/**
 * The eight, by what each is a reading of rather than by what it would be nice to know.
 *
 * `storage-format` is where the plan said "performance". Renamed to the field it reads, because a
 * dimension called performance that reports a format is a sentence a reader will quote as a latency.
 */
export type DimensionId =
  | 'unity-catalog-boundary'
  | 'table-metadata'
  | 'column-metadata'
  | 'semantic-assets'
  | 'lineage'
  | 'quality-monitoring'
  | 'policy-controls'
  | 'storage-format';

/** How far along a dimension is, or that it could not be read. Never "ready because nothing was read". */
export type DimensionStanding = 'ready' | 'partial' | 'short' | 'unmeasured';

/**
 * Where the two thresholds sit, carried on the reading so a reader can see them.
 *
 * On the reading rather than in a table somewhere, because a standing without its thresholds is an
 * opinion: 72% is `partial` here and would be `ready` under a different pair, and the reader cannot
 * tell which they are looking at unless the numbers travel with the word.
 */
export interface Bands {
  /** At or above this share of the denominator, the dimension is `ready`. */
  readonly ready: number;
  /** At or above this, `partial`. Below it, `short`. */
  readonly partial: number;
}

/**
 * What a dimension's share is a share of, said in words and counted.
 *
 * `excluded` is the half that makes the denominator honest rather than merely present. A policy
 * dimension over assets no classification covers would divide by every serving asset and report an
 * estate that classifies nothing as fully protected; saying how many were left out, and why, is the
 * difference between a share of the assets that owe something and a share of all of them.
 */
export interface Denominator {
  /** The population, as a noun phrase: "serving assets whose relation kind was read". */
  readonly of: string;
  readonly count: number;
  readonly excluded: number;
  /** Why those were left out. Empty where none were. */
  readonly excludedBecause: string;
}

export interface DimensionReading {
  readonly id: DimensionId;
  /** One higher whenever what this dimension counts changes, so two readings can say if they agree. */
  readonly version: number;
  readonly bands: Bands;
  readonly denominator: Denominator;
  readonly met: number;
  readonly short: number;
  /** In the population, owing this, and the evidence could not say. Not in the denominator. */
  readonly unmeasured: number;
  /** `met / denominator.count`, or null where the denominator is empty. */
  readonly share: number | null;
  readonly standing: DimensionStanding;
  /** Why there is no share, when there is none. Absent when the dimension was read. */
  readonly because?: string;
  /** The assets short of it, by qualified name, in canonical order. */
  readonly shortfall: readonly string[];
}

/**
 * Something a reader would expect this outcome to report and it does not, with what settled that.
 *
 * A dimension left out silently is indistinguishable from one nobody thought of, and this outcome
 * leaves out the one thing every reader arrives asking about. See ADR 0086.
 */
export interface Absence {
  readonly what: string;
  readonly because: string;
  /** What was read to find that out, so the next reader checks the source rather than this sentence. */
  readonly measured: string;
}

export interface ReadinessOutcome {
  /** The declaration these readings are of, or null where none is declared. */
  readonly declared: { readonly version: number; readonly fingerprint: Digest } | null;
  readonly population: PopulationSummary;
  readonly dimensions: readonly DimensionReading[];
  readonly absent: readonly Absence[];
}

export interface PopulationSummary {
  readonly assets: number;
  /** Named by the declaration and not in the catalogue that was read. */
  readonly missing: number;
  /** True where the read stopped at its cap, so the population is part of one. */
  readonly truncated: boolean;
  /** True where nothing is declared, which is why every dimension below is unmeasured. */
  readonly undeclared: boolean;
}

/**
 * What a caller read about each asset, one row per asset in the population.
 *
 * Every field is optional and `undefined` means the read did not carry it, which is the distinction
 * `serving-asset.ts` draws between `null` and `[]` one layer down. A zero is a reading: `lineageEvents:
 * 0` is a table nothing touched in the window, and `lineageEvents: undefined` is a window nobody
 * looked at.
 */
export interface AssetFacts {
  readonly qualified: string;
  /** `table_type`, as `information_schema` spells it: MANAGED, EXTERNAL, VIEW, FOREIGN, METRIC_VIEW… */
  readonly kind?: string | null;
  /** `data_source_format`: DELTA, ICEBERG, CSV… Null on a relation that stores nothing. */
  readonly format?: string | null;
  readonly columns?: number | null;
  readonly commentedColumns?: number | null;
  /** Lineage events naming this asset on either side, inside the window the caller read. */
  readonly lineageEvents?: number | null;
  /** Metric views that lineage says read this asset, inside the same window. */
  readonly semanticReaders?: number | null;
  /** The status the platform's quality monitoring recorded, or null where it recorded none. */
  readonly qualityStatus?: string | null;
}

/**
 * Everything the outcome is computed from: the declaration's own evidence, plus the per-asset facts.
 *
 * `facts: null` is the whole per-asset read not having happened, which is six of the eight dimensions
 * unmeasured at once. `truncated` is the read having stopped at its cap, which is a different thing
 * again: the readings are of a population that is a part of the declared one, and every share below is
 * a share of that part.
 */
export interface ReadinessEvidence {
  readonly serving: ServingEvidence;
  readonly facts: readonly AssetFacts[] | null;
  readonly truncated?: boolean;
  /**
   * The population the per-asset facts were read for, where the caller resolved it in an earlier pass.
   *
   * Absent means recompute it from `serving`, which is what a caller holding all the evidence at once
   * does. A caller that reads in two passes has to supply it, for two reasons that point the same way.
   * The facts were fetched *for these assets*, so an outcome over a population recomputed from
   * different evidence would be reporting one population's facts under another's name. And the second
   * pass has its own failure: when the tag read fails, `serving.tags` is null — unread, correctly —
   * and recomputing would then drop every asset a tag selected, turning one unreadable statement into
   * an estate that serves fewer tables.
   */
  readonly population?: ServingPopulation;
}

/** Neither threshold is measured. They are this app's, and they are on every reading for that reason. */
const BANDS: Bands = { ready: 0.9, partial: 0.6 };

/** A relation reached through a connection to another system, as `table_type` spells it. */
const FEDERATED = 'FOREIGN';

/** The two `table_type` values that hold data of their own, which is what a format is a fact about. */
const STORED = new Set(['MANAGED', 'EXTERNAL']);

/** The formats `45a` counted as `optimized_format_tables` on the measurement estate. */
const OPTIMISED = new Set(['DELTA', 'ICEBERG']);

const UNDECLARED = 'no serving definition is declared, so there is no population to read this over';

const NOT_READ = 'the evidence for this dimension was not read';

/**
 * What each asset owes this dimension, per asset: met, short, or the evidence could not say.
 *
 * `null` is `unmeasured` and `'excluded'` is an asset the dimension does not apply to, which is not
 * the same thing and must not be counted as one. A view has no storage format and a table no class
 * covers owes no mask; both are out of the denominator, and both would read as a failure if the only
 * two answers were yes and no.
 */
type Verdict = 'met' | 'short' | 'excluded' | null;

interface Dimension {
  readonly id: DimensionId;
  readonly version: number;
  /** The denominator's noun phrase, and why anything is out of it. */
  readonly of: string;
  readonly excludedBecause: string;
  readonly verdict: (asset: string, context: Context) => Verdict;
}

interface Context {
  readonly facts: ReadonlyMap<string, AssetFacts>;
  readonly factsRead: boolean;
  readonly metadata: ReadonlyMap<string, MetadataReading>;
  readonly policy: ReadonlyMap<string, PolicyReading>;
}

/**
 * The eight dimensions, each with the field it reads and the population it reads over.
 *
 * Declared as data rather than written as eight functions so that the denominator, the version and the
 * rule sit in one place and cannot drift from each other — the failure `45a` measured is precisely a
 * numerator that moved to a different population than the one its label named.
 */
const DIMENSIONS: readonly Dimension[] = [
  {
    id: 'unity-catalog-boundary',
    version: 1,
    of: 'serving assets whose relation kind was read',
    excludedBecause: '',
    verdict: (asset, context) => {
      const kind = context.facts.get(asset)?.kind;
      if (kind == null) return null;
      return kind.toUpperCase() === FEDERATED ? 'short' : 'met';
    },
  },
  {
    id: 'table-metadata',
    version: 1,
    of: 'serving assets whose description, owner and tags the definition requires',
    excludedBecause: '',
    verdict: (asset, context) => {
      const reading = context.metadata.get(asset);
      if (reading == null || reading.standing === 'unmeasured') return null;
      return reading.standing === 'met' ? 'met' : 'short';
    },
  },
  {
    id: 'column-metadata',
    version: 1,
    of: 'serving assets whose columns were read',
    excludedBecause: '',
    verdict: (asset, context) => {
      const facts = context.facts.get(asset);
      const columns = facts?.columns;
      const commented = facts?.commentedColumns;
      if (columns == null || commented == null) return null;
      // A relation the read found no columns for is a read that says nothing about its comments, not a
      // relation whose every column is commented. The share would otherwise rise as the read got worse.
      if (columns === 0) return null;
      return commented >= columns ? 'met' : 'short';
    },
  },
  {
    id: 'semantic-assets',
    version: 1,
    of: 'serving assets whose relation kind and lineage were read',
    excludedBecause: '',
    verdict: (asset, context) => {
      const facts = context.facts.get(asset);
      if (facts == null) return null;
      if (facts.kind != null && facts.kind.toUpperCase() === 'METRIC_VIEW') return 'met';
      const readers = facts.semanticReaders;
      if (readers == null) return null;
      return readers > 0 ? 'met' : 'short';
    },
  },
  {
    id: 'lineage',
    version: 1,
    of: 'serving assets whose lineage was read',
    excludedBecause: '',
    verdict: (asset, context) => {
      const events = context.facts.get(asset)?.lineageEvents;
      if (events == null) return null;
      return events > 0 ? 'met' : 'short';
    },
  },
  {
    id: 'quality-monitoring',
    version: 1,
    of: 'serving assets whose quality monitoring was read',
    excludedBecause: '',
    verdict: (asset, context) => {
      const facts = context.facts.get(asset);
      if (facts == null || !('qualityStatus' in facts)) return null;
      // Whether the platform recorded a status, not whether the status was a good one. The four values
      // it writes are the platform's and this app has not measured what any of them means, so counting
      // one of them as a pass would be this module deciding that on the platform's behalf.
      return facts.qualityStatus == null ? 'short' : 'met';
    },
  },
  {
    id: 'policy-controls',
    version: 1,
    of: 'serving assets a classification rule requires a protection of',
    excludedBecause: 'no rule in the declared matrix covers a classification on them',
    verdict: (asset, context) => {
      const reading = context.policy.get(asset);
      if (reading == null || reading.standing === 'unmeasured') return null;
      if (reading.standing === 'not-required') return 'excluded';
      return reading.standing === 'met' ? 'met' : 'short';
    },
  },
  {
    id: 'storage-format',
    version: 1,
    of: 'serving assets that store data of their own',
    excludedBecause: 'they are views or federated relations, which hold no format of their own',
    verdict: (asset, context) => {
      const facts = context.facts.get(asset);
      if (facts == null || facts.kind == null) return null;
      if (!STORED.has(facts.kind.toUpperCase())) return 'excluded';
      if (facts.format == null) return null;
      return OPTIMISED.has(facts.format.toUpperCase()) ? 'met' : 'short';
    },
  },
];

/**
 * What a reader would come here for and will not find, with the reading that settled it.
 *
 * Two entries. The first is the one every reader arrives asking about; the second is the one a reader
 * only notices after declaring a matrix that requires it. Exported so the surface can render them
 * beside the dimensions rather than in a footnote nobody reaches.
 */
export function absences(): readonly Absence[] {
  return [
    {
      what: 'how much any of this is used through Genie',
      because:
        'no platform source attributes a Genie event to a table. system.access.assistant_events carries ' +
        'no space, conversation, asset or feedback column, and a Genie space does not name the tables it ' +
        'serves, so a usage dimension here would be activity standing in for attribution.',
      measured:
        'seven columns on system.access.assistant_events over 99,418 events, and a complete walk of 4,181 ' +
        'Genie spaces. Measured on the large-estate calibration estate over the 30-day window ending ' +
        '2026-08-15.',
    },
    {
      what: 'whether an ABAC policy covers an asset a rule requires one of',
      because:
        'the read that would answer it costs more than the rest of this outcome put together, so nothing ' +
        'here queries it. An asset whose rules require an ABAC policy is reported unmeasured on the ' +
        'policy dimension rather than short: this app has not looked, which is not the same as not found.',
      measured:
        '720 rows in 16m 32s from system.information_schema.abac_policy_definitions, against 1.2 to 11 ' +
        'seconds for every other source timed. Measured on the large-estate calibration estate over the ' +
        '30-day window ending 2026-08-15.',
    },
  ];
}

/**
 * The eight readings over a declaration, or eight unmeasured ones where nothing is declared.
 *
 * The undeclared case is the one worth being deliberate about. A definition that selects nothing is
 * refused rather than stored (`defineServing`), so "nobody has declared what they serve" arrives here
 * as an absent definition rather than as an empty population — and the difference matters, because an
 * empty population divides every share by zero and a surface that renders that as 0% is telling a
 * customer their governance is failing when what is missing is a sentence about which tables are theirs.
 */
export function readiness(definition: ServingDefinition | null, evidence: ReadinessEvidence): ReadinessOutcome {
  if (definition == null) {
    return {
      declared: null,
      population: { assets: 0, missing: 0, truncated: evidence.truncated === true, undeclared: true },
      dimensions: DIMENSIONS.map((dimension) => unreadable(dimension, UNDECLARED)),
      absent: absences(),
    };
  }

  const population = evidence.population ?? servingPopulation(definition, evidence.serving);
  const context = contextFor(definition, population, evidence);

  return {
    declared: { version: definition.version, fingerprint: definition.fingerprint },
    population: {
      assets: population.assets.length,
      missing: population.missing.length,
      truncated: evidence.truncated === true,
      undeclared: false,
    },
    dimensions: DIMENSIONS.map((dimension) => read(dimension, population, context)),
    absent: absences(),
  };
}

function contextFor(
  definition: ServingDefinition,
  population: ServingPopulation,
  evidence: ReadinessEvidence
): Context {
  return {
    facts: new Map((evidence.facts ?? []).map((row) => [row.qualified, row])),
    factsRead: evidence.facts != null,
    metadata: new Map(
      metadataReadings(definition, population, evidence.serving).map((reading) => [reading.qualified, reading])
    ),
    policy: new Map(
      policyReadings(definition, population, evidence.serving).map((reading) => [reading.qualified, reading])
    ),
  };
}

function read(dimension: Dimension, population: ServingPopulation, context: Context): DimensionReading {
  let met = 0;
  let fell = 0;
  let unmeasured = 0;
  let excluded = 0;
  const shortfall: string[] = [];

  for (const asset of population.assets) {
    const verdict = dimension.verdict(asset.qualified, context);
    if (verdict === 'met') met += 1;
    else if (verdict === 'excluded') excluded += 1;
    else if (verdict === 'short') {
      fell += 1;
      shortfall.push(asset.qualified);
    } else unmeasured += 1;
  }

  const counted = met + fell;
  const denominator: Denominator = {
    of: dimension.of,
    count: counted,
    excluded,
    excludedBecause: excluded > 0 ? dimension.excludedBecause : '',
  };

  if (counted === 0) {
    return {
      ...unreadable(dimension, reasonForNothing(population, unmeasured, excluded, context.factsRead)),
      denominator,
      unmeasured,
    };
  }

  const share = met / counted;
  return {
    id: dimension.id,
    version: dimension.version,
    bands: BANDS,
    denominator,
    met,
    short: fell,
    unmeasured,
    share,
    standing: share >= BANDS.ready ? 'ready' : share >= BANDS.partial ? 'partial' : 'short',
    shortfall: shortfall.sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * Why a dimension counted nobody, in the reader's terms rather than in the code's.
 *
 * Four ways to arrive at an empty denominator and they are four different pieces of news. Only one of
 * them — everything excluded — is a fact about the estate; the other three are facts about what was
 * declared or what was read, and a surface that renders all four as "0%" reports the estate for all of
 * them.
 */
function reasonForNothing(
  population: ServingPopulation,
  unmeasured: number,
  excluded: number,
  factsRead: boolean
): string {
  if (population.assets.length === 0) {
    return population.catalogueUnread
      ? 'the catalogue was not read, so the declared assets could not be found in it'
      : 'the declaration selected no asset the catalogue holds';
  }
  if (unmeasured > 0) return factsRead ? NOT_READ : 'the per-asset read did not happen';
  if (excluded > 0) return 'every serving asset is out of this denominator';
  return NOT_READ;
}

function unreadable(dimension: Dimension, because: string): DimensionReading {
  return {
    id: dimension.id,
    version: dimension.version,
    bands: BANDS,
    denominator: { of: dimension.of, count: 0, excluded: 0, excludedBecause: '' },
    met: 0,
    short: 0,
    unmeasured: 0,
    share: null,
    standing: 'unmeasured',
    because,
    shortfall: [],
  };
}
