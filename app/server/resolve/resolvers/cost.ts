// Cost optimisation resolvers.
//
// The recurring judgement in this file is what the denominator should be. Photon
// adoption measured against total spend can never reach 100%, because storage and
// serving lines have no Photon option — so full adoption would report as partial
// forever. Auto-termination measured across every cluster row penalises job
// clusters, which are ephemeral by construction and have no auto-termination to
// set. Each resolver states the population it assesses, and reports it as evidence,
// because a share whose denominator is unstated is not a measurement.

import type { ControlResolver } from '../resolver.js';
import type {
  ClusterRow,
  ComputeMix,
  CostAttribution,
  JobRow,
  AssetCensus,
  SchemaCensusRow,
  SqlPaths,
  WarehouseRow,
} from '../../collect/sql/shapes.js';
import { isAllPurpose } from '../../collect/sql/shapes.js';
import { share } from '../../collect/sql/rows.js';
import { asCluster, asJob, asWarehouse } from '../locate.js';
import {
  bandOutcome,
  bandsOf,
  detailFrom,
  enrichedBy,
  evidenceFrom,
  fromSignal,
  fromSignals,
  money,
  nameIn,
  offenders,
  notApplicable,
  percent,
  priceBarrier,
  priceCoverageClause,
  satisfiedByArchitecture,
  threshold,
  unmeasured,
  valueOf,
} from './helpers.js';
import { estateExclusion, SCHEMA_CENSUS, whereTheGapIs } from './segments.js';
import { unestablishedEmptiness, VISIBILITY_CROSS_CHECK } from './visibility.js';

const CLUSTERS = 'sql:compute.clusters';
const WAREHOUSES = 'sql:compute.warehouses';
const MIX = 'sql:cost.compute_mix';
const ATTRIBUTION = 'sql:cost.attribution';
const CENSUS = 'sql:uc.census';
const JOBS = 'sql:jobs.inventory';
const SQL_PATHS = 'sql:workload.sql_paths';

/** Counts the format resolvers subtract: relations that store no format of their own. */
interface FormatLeftover {
  readonly views: number;
  readonly metricViews: number;
  readonly foreignTables: number;
}

function leftoverWithoutFormat(census: {
  readonly views: number;
  readonly metricViews?: number;
  readonly foreignTables?: number;
}): FormatLeftover {
  return {
    views: census.views,
    // Absent on a scan stored before these fields existed. Zero keeps that scan resolvable.
    metricViews: census.metricViews ?? 0,
    foreignTables: census.foreignTables ?? 0,
  };
}

function formatPopulation(
  census: { readonly tableCount: number } & Parameters<typeof leftoverWithoutFormat>[0]
): number {
  const leftover = leftoverWithoutFormat(census);
  return census.tableCount - leftover.views - leftover.metricViews - leftover.foreignTables;
}

function formatGap(schema: SchemaCensusRow): number {
  return formatPopulation(schema) - schema.optimizedFormatTables;
}

function countNoun(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function leftoverParts(leftover: FormatLeftover): readonly string[] {
  const parts: string[] = [];
  if (leftover.views > 0) parts.push(countNoun(leftover.views, 'view', 'views'));
  if (leftover.metricViews > 0) parts.push(countNoun(leftover.metricViews, 'metric view', 'metric views'));
  if (leftover.foreignTables > 0) parts.push(countNoun(leftover.foreignTables, 'foreign table', 'foreign tables'));
  return parts;
}

function joinAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function noFormatReason(census: { readonly tableCount: number } & Parameters<typeof leftoverWithoutFormat>[0]): string {
  const leftover = leftoverWithoutFormat(census);
  if (leftover.views === census.tableCount && leftover.metricViews === 0 && leftover.foreignTables === 0) {
    return 'This metastore contains only views, which have no storage format to choose.';
  }
  if (leftover.metricViews === census.tableCount && leftover.views === 0 && leftover.foreignTables === 0) {
    return 'This metastore contains only metric views, which have no storage format to choose.';
  }
  if (leftover.foreignTables === census.tableCount && leftover.views === 0 && leftover.metricViews === 0) {
    return 'This metastore contains only foreign tables, which have no storage format to choose.';
  }
  return `This metastore contains ${joinAnd(leftoverParts(leftover))}, which have no storage format to choose.`;
}

/**
 * CO-01-01, REL-01-01, DG-03-03 and IU-02-01: open, performance-optimised table formats.
 *
 * Four controls, one observation. Cost asks for a format that reads efficiently,
 * reliability asks for one with ACID transactions, governance asks for a standardised one,
 * interoperability asks for an open one, and Delta or Iceberg is the answer to all four.
 * They are alias-grouped so a single format problem is not counted four times.
 *
 * Interoperability joins on the same reasoning the WAF gives it: the reason to prefer an
 * open format is that another engine can read it without a copy, and that is a property of
 * Delta and Iceberg rather than a separate configuration to check.
 *
 * Views, metric views and foreign tables are excluded from the denominator: none of
 * them has a storage format to choose. A stored scan from before those two counts
 * existed is missing the fields; they read as zero so the scan still resolves.
 */
const dataFormats = enrichedBy(
  [SCHEMA_CENSUS, VISIBILITY_CROSS_CHECK],
  fromSignal<AssetCensus>(CENSUS, ['CO-01-01', 'REL-01-01', 'DG-03-03', 'IU-02-01'], (census, context) => {
    const leftover = leftoverWithoutFormat(census);
    const population = formatPopulation(census);
    if (population <= 0)
      // Only where the census read nothing at all. An estate of views (or metric views,
      // or foreign tables) has a population of zero too, and that is a shape the reading
      // did establish — see E1d. It gets its own sentence, because "contains no tables"
      // is false of an estate holding leftover relations that store no format.
      return (
        (census.tableCount === 0 ? unestablishedEmptiness(context) : undefined) ??
        notApplicable(
          census.tableCount === 0
            ? 'This metastore contains no tables, so there is no format choice to assess.'
            : noFormatReason(census)
        )
      );

    const adopted = share(census.optimizedFormatTables, population);
    // Converting a table's format is per-table work, so where the unconverted ones sit
    // decides whether this is one pipeline's output or a scattered backlog.
    const gap = whereTheGapIs(context, formatGap);
    const exclusion = estateExclusion(census);
    const leftoverNote =
      leftover.views + leftover.metricViews + leftover.foreignTables > 0
        ? `; ${joinAnd(leftoverParts(leftover))} are out of the denominator`
        : '';
    return {
      outcome: bandOutcome(adopted, bandsOf(context.spec, { pass: 0.95, partial: 0.7 })),
      evidence: [
        evidenceFrom(
          context,
          CENSUS,
          `${census.optimizedFormatTables} of ${population} tables are Delta or Iceberg (${percent(adopted)}); ` +
            `${census.deltaTables} Delta, ${census.icebergTables} Iceberg${leftoverNote}`,
          'Tables use an open, performance-optimised format rather than raw CSV, JSON or bare Parquet'
        ),
        ...(gap != null ? [detailFrom(context, SCHEMA_CENSUS, gap)] : []),
        ...(exclusion != null ? [detailFrom(context, CENSUS, exclusion)] : []),
      ],
    };
  })
);

/**
 * CO-01-02: jobs should run on job compute, not all-purpose.
 *
 * Measured in billed cost attributed to a job on an all-purpose SKU, rather than by
 * counting clusters. A job pinned to an all-purpose cluster that runs once a month
 * costs almost nothing; one that runs hourly is the finding, and only the money
 * distinguishes them.
 */
const jobCompute = fromSignal<ComputeMix>(MIX, ['CO-01-02'], (mix, context) => {
  // Price coverage is checked before the empty-bill branch, and the order is the whole point: since
  // Q1c the monetary sums are priced rows only, so an estate whose SKUs are absent from
  // `list_prices` arrives here with `totalCost` at zero and usage behind it. Asked the other way
  // round, it is told no usage was billed — a claim about the estate, from a gap in the price list.
  const barrier = priceBarrier(mix, 'a share of job spend on all-purpose compute');
  if (barrier != null) return unmeasured(barrier, 'attestation');
  if (mix.totalCost <= 0)
    return notApplicable('No billable usage was recorded in the window, so there is no spend to assess.');
  if (mix.choiceCost <= 0) {
    return notApplicable(
      `None of the ${money(mix.totalCost, mix.currency)} billed in the window was on job, all-purpose, SQL or pipeline ` +
        'compute, so there is no compute choice here to get wrong.'
    );
  }

  /*
   * Against the compute somebody chose the shape of, not against the whole bill.
   *
   * The denominator was `totalCost`, which is every billed line. An estate spending heavily on model
   * serving could then run every job on an all-purpose cluster and still land in the pass band, because
   * the waste was a small fraction of a bill it has nothing to do with.
   */
  const wasted = share(mix.jobsOnAllPurposeCost, mix.choiceCost) ?? 0;
  const bands = bandsOf(context.spec, { pass: 0.98, partial: 0.85 });
  return {
    outcome: bandOutcome(1 - wasted, bands),
    evidence: [
      evidenceFrom(
        context,
        MIX,
        mix.jobsOnAllPurposeCost <= 0
          ? `No job-attributed spend on all-purpose compute, out of ${money(mix.choiceCost, mix.currency)} on compute somebody configured (${priceCoverageClause(mix)})`
          : `${money(mix.jobsOnAllPurposeCost, mix.currency)} of ${money(mix.choiceCost, mix.currency)} (${percent(wasted)}) is job-attributed spend on all-purpose compute (${priceCoverageClause(mix)})`,
        'Scheduled work runs on job compute, which is billed at a lower rate than all-purpose'
      ),
    ],
  };
});

/**
 * CO-01-04: current runtimes.
 *
 * The threshold is a major version from the catalogue rather than a list of
 * supported releases in code. A list would be wrong within a quarter, and being
 * wrong here means telling a customer a supported runtime is out of date.
 */
const runtimes = fromSignal<ClusterRow[]>(CLUSTERS, ['CO-01-04'], (clusters, context) => {
  const population = clusters.filter(isAllPurpose);
  if (population.length === 0) {
    return satisfiedByArchitecture(
      'This estate runs no classic all-purpose clusters, so there is no runtime version to keep current — ' +
        'serverless compute is upgraded by the platform.'
    );
  }

  const minimum = threshold(context.spec, 'min_runtime_major', 14);
  const current = population.filter((cluster) => majorVersion(cluster.runtime) >= minimum);
  const adopted = share(current.length, population.length);
  const stale = population.filter((cluster) => majorVersion(cluster.runtime) < minimum);

  return {
    outcome: bandOutcome(adopted, bandsOf(context.spec, { pass: 0.9, partial: 0.6 })),
    evidence: [
      evidenceFrom(
        context,
        CLUSTERS,
        `${current.length} of ${population.length} all-purpose clusters run DBR ${minimum} or later` +
          (stale.length > 0 ? `; oldest: ${describeOldest(stale, nameIn(context))}` : ''),
        `All-purpose clusters run Databricks Runtime ${minimum} or later`
      ),
    ],
  };
});

/**
 * CO-01-05: GPUs only where they earn their price.
 *
 * A configuration cannot show whether a GPU workload needed a GPU, so a GPU cluster
 * is never reported as a failure here. Absence of GPUs is a pass because there is
 * nothing to misuse; presence is partial with the clusters named, which is the
 * honest limit of what a config-level check can say.
 */
const gpus = fromSignal<ClusterRow[]>(CLUSTERS, ['CO-01-05'], (clusters, context) => {
  const gpuClusters = clusters.filter((cluster) => cluster.gpuNode);
  if (gpuClusters.length === 0) {
    return {
      outcome: 'pass',
      evidence: [
        evidenceFrom(
          context,
          CLUSTERS,
          'No GPU-backed clusters are configured',
          'GPUs are used only for workloads that need them'
        ),
      ],
    };
  }

  return {
    outcome: 'partial',
    evidence: [
      evidenceFrom(
        context,
        CLUSTERS,
        `${gpuClusters.length} GPU-backed cluster${gpuClusters.length === 1 ? '' : 's'}`,
        'GPUs are used only for workloads that need them'
      ),
      ...offenders(context, CLUSTERS, 'On GPU nodes', gpuClusters, asCluster, {
        note: (cluster) => cluster.workerNodeType ?? 'unknown node type',
      }),
    ],
    outcomeReason:
      'Whether these workloads need GPUs cannot be determined from configuration alone. ' +
      'Confirm each is doing GPU-accelerated work; the check can only show that GPUs are in use.',
  };
});

/**
 * CO-01-06, PE-02-01, REL-01-06 and IU-03-02: serverless adoption, by spend not resource count.
 *
 * Spend because a stopped classic cluster and a busy one count the same in a
 * resource census, and the question the four pillars are asking — how much of what
 * you run is on managed compute — is about the running, not the inventory.
 *
 * Interoperability asks for it as the shortest path to a working workload, which is the
 * same configuration read for a different reason, so it scores from this one measurement.
 */
const serverless = fromSignal<ComputeMix>(MIX, ['CO-01-06', 'PE-02-01', 'REL-01-06', 'IU-03-02'], (mix, context) => {
  // Before the empty-bill branch, for the reason given in CO-01-02 above.
  const barrier = priceBarrier(mix, 'a serverless adoption share');
  if (barrier != null) return unmeasured(barrier, 'attestation');
  if (mix.totalCost <= 0)
    return notApplicable('No billable usage was recorded in the window, so there is no spend to assess.');

  /*
   * Nothing to assess where nothing in the window had a form to choose.
   *
   * An estate that is entirely model serving, Lakebase and Apps has made no serverless decision, and
   * scoring it against a denominator of zero would either divide by nothing or report 0% adoption for
   * running only serverless products.
   */
  if (mix.choiceCost <= 0) {
    return notApplicable(
      `None of the ${money(mix.totalCost, mix.currency)} billed in the window was on compute with a serverless option — ` +
        'jobs, all-purpose, SQL warehouses or pipelines. The rest of the estate is on products that have ' +
        'no classic form to move away from.'
    );
  }

  const adopted = share(mix.serverlessChoiceCost, mix.choiceCost);
  // Spend that had no choice in it, named so the denominator does not look like a mistake. A reader
  // who knows their monthly bill is $16,000 and sees a share of $258 will otherwise distrust the
  // number, which is the wrong lesson to draw from a correct one.
  const settled = mix.totalCost - mix.choiceCost;
  return {
    outcome: bandOutcome(adopted, bandsOf(context.spec, { pass: 0.8, partial: 0.3 })),
    evidence: [
      evidenceFrom(
        context,
        MIX,
        `${money(mix.serverlessChoiceCost, mix.currency)} of ${money(mix.choiceCost, mix.currency)} (${percent(adopted)}) of the spend that ` +
          `has a serverless option is serverless` +
          (settled > 0
            ? `. A further ${money(settled, mix.currency)} is on products with no classic form — serving, Lakebase, Apps, storage — and is not counted either way`
            : '') +
          ` (${priceCoverageClause(mix)})`,
        'Workloads run on serverless compute where the workload suits it'
      ),
    ],
  };
});

/**
 * CO-01-10 and PE-03-08: Photon, against the spend that could have used it.
 *
 * Serverless SQL and serverless jobs run Photon by design without appearing under a
 * Photon SKU, so a serverless estate would otherwise score zero adoption for
 * already having the thing the control asks for.
 */
const photon = fromSignal<ComputeMix>(MIX, ['CO-01-10', 'PE-03-08'], (mix, context) => {
  const barrier = priceBarrier(mix, 'a Photon adoption share');
  if (barrier != null) return unmeasured(barrier, 'attestation');
  if (mix.photonEligibleCost <= 0) {
    return notApplicable('No spend in the window was on compute where Photon is an option.');
  }

  /*
   * The share over the Photon-eligible spend, not over the whole bill.
   *
   * Over the whole bill this branch does not fire when it should, and the control then fails an estate
   * for not enabling a setting it has no way to enable. Measured: a workspace whose eligible spend was
   * 100% serverless SQL read 21% serverless against its total bill — the rest being model serving —
   * took the ordinary path, found no Photon SKU because serverless does not bill one, and reported
   * 0% Photon adoption as a failure.
   */
  const serverlessShare = share(mix.serverlessChoiceCost, mix.photonEligibleCost) ?? 0;
  if (serverlessShare >= threshold(context.spec, 'serverless_credit_share', 0.95)) {
    return satisfiedByArchitecture(
      `${percent(serverlessShare)} of the spend where Photon is an option is serverless, and serverless SQL ` +
        'and jobs run the vectorised engine by default, so there is no separate Photon setting to enable.',
      [
        evidenceFrom(
          context,
          MIX,
          `${money(mix.serverlessChoiceCost, mix.currency)} of ${money(mix.photonEligibleCost, mix.currency)} Photon-eligible spend is serverless (${priceCoverageClause(mix)})`
        ),
      ]
    );
  }

  const adopted = share(mix.photonCost, mix.photonEligibleCost);
  return {
    outcome: bandOutcome(adopted, bandsOf(context.spec, { pass: 0.7, partial: 0.3 })),
    evidence: [
      evidenceFrom(
        context,
        MIX,
        `${money(mix.photonCost, mix.currency)} of ${money(mix.photonEligibleCost, mix.currency)} (${percent(adopted)}) of Photon-eligible spend ran on Photon (${priceCoverageClause(mix)})`,
        'Photon or serverless compute is used for the compute that can benefit from it'
      ),
    ],
  };
});

/**
 * CO-02-01 and REL-03-01: elastic capacity.
 *
 * One observation, two pillars' intents — cost avoids paying for idle capacity,
 * reliability absorbs load without manual intervention. Scored once through the
 * alias group so a single misconfiguration is not counted twice.
 */
const autoscaling = fromSignals([CLUSTERS, WAREHOUSES], ['CO-02-01', 'REL-03-01'], (context) => {
  const clusters = valueOf<ClusterRow[]>(context, CLUSTERS).filter(isAllPurpose);
  const warehouses = valueOf<WarehouseRow[]>(context, WAREHOUSES);
  const population = clusters.length + warehouses.length;

  if (population === 0) {
    return satisfiedByArchitecture(
      'There are no classic clusters or SQL warehouses to configure. Serverless compute scales ' +
        'without a capacity setting, so the intent is met by the architecture.'
    );
  }

  const elastic =
    clusters.filter((c) => c.autoscaling).length + warehouses.filter((w) => w.serverless || w.scalesOut).length;
  const adopted = share(elastic, population);

  return {
    outcome: bandOutcome(adopted, bandsOf(context.spec, { pass: 0.8, partial: 0.4 })),
    evidence: [
      evidenceFrom(
        context,
        CLUSTERS,
        `${clusters.filter((c) => c.autoscaling).length} of ${clusters.length} all-purpose clusters autoscale`,
        'Compute scales with demand rather than being fixed at peak size'
      ),
      evidenceFrom(
        context,
        WAREHOUSES,
        `${warehouses.filter((w) => w.serverless || w.scalesOut).length} of ${warehouses.length} SQL warehouses scale out or are serverless`,
        'Warehouses scale with concurrency rather than being fixed'
      ),
    ],
  };
});

/** CO-02-02: idle compute should stop. Job clusters are excluded: they end with the run. */
const autoTermination = fromSignals([CLUSTERS, WAREHOUSES], ['CO-02-02'], (context) => {
  const clusters = valueOf<ClusterRow[]>(context, CLUSTERS).filter(isAllPurpose);
  const warehouses = valueOf<WarehouseRow[]>(context, WAREHOUSES);
  const population = clusters.length + warehouses.length;

  if (population === 0) {
    return satisfiedByArchitecture(
      'There is no long-running compute to terminate. Serverless compute is released when idle ' +
        'without an auto-termination setting.'
    );
  }

  const terminating = clusters.filter((c) => c.autoTerminates).length + warehouses.filter((w) => w.autoStops).length;
  const adopted = share(terminating, population);

  return {
    outcome: bandOutcome(adopted, bandsOf(context.spec, { pass: 1, partial: 0.7 })),
    evidence: [
      evidenceFrom(
        context,
        CLUSTERS,
        `${clusters.filter((c) => c.autoTerminates).length} of ${clusters.length} all-purpose clusters auto-terminate`,
        'Every all-purpose cluster has an auto-termination window'
      ),
      ...offenders(
        context,
        CLUSTERS,
        'Without it',
        clusters.filter((c) => !c.autoTerminates),
        asCluster
      ),
      evidenceFrom(
        context,
        WAREHOUSES,
        `${warehouses.filter((w) => w.autoStops).length} of ${warehouses.length} SQL warehouses auto-stop`,
        'Every SQL warehouse has an auto-stop window'
      ),
      ...offenders(
        context,
        WAREHOUSES,
        'Without it',
        warehouses.filter((w) => !w.autoStops),
        asWarehouse
      ),
    ],
  };
});

/**
 * CO-02-03: compute policies.
 *
 * The single most important applicability case in the app. An estate with no classic
 * all-purpose clusters has nothing for a policy to constrain, and reporting that as
 * a failure would tell a customer their best architectural decision made them less
 * compliant. It is credited as satisfied by architecture, not quietly dropped: the
 * customer earned the outcome and should see that they did.
 */
const computePolicies = fromSignal<ClusterRow[]>(CLUSTERS, ['CO-02-03'], (clusters, context) => {
  const population = clusters.filter(isAllPurpose);
  if (population.length === 0) {
    return satisfiedByArchitecture(
      'There are no classic all-purpose clusters in this estate, so there is no cluster configuration ' +
        'for a policy to constrain. Serverless compute has no instance type, node count or runtime for a ' +
        'user to choose wrongly, which is what a compute policy exists to prevent.',
      [evidenceFrom(context, CLUSTERS, `${clusters.length} cluster records, none of them all-purpose classic compute`)]
    );
  }

  const governed = population.filter((cluster) => cluster.hasPolicy);
  const adopted = share(governed.length, population.length);

  return {
    outcome: bandOutcome(adopted, bandsOf(context.spec, { pass: 0.9, partial: 0.5 })),
    evidence: [
      evidenceFrom(
        context,
        CLUSTERS,
        `${governed.length} of ${population.length} all-purpose clusters were created under a compute policy`,
        'All-purpose clusters are created under a policy that bounds size, runtime and cost'
      ),
    ],
  };
});

/** CO-04-02: spot or capacity-excess instances where interruption is tolerable. */
const spotUsage = fromSignal<ClusterRow[]>(CLUSTERS, ['CO-04-02'], (clusters, context) => {
  const population = clusters.filter((cluster) => cluster.availability != null);
  if (population.length === 0) {
    return notApplicable(
      'No classic compute with a cloud availability setting was found, so there is no on-demand ' +
        'versus spot balance to assess. Serverless compute does not expose this choice.'
    );
  }

  const spot = population.filter((cluster) => /SPOT|PREEMPTIBLE|LOWEST_PRICE/i.test(cluster.availability ?? ''));
  const adopted = share(spot.length, population.length);

  return {
    outcome: bandOutcome(adopted, bandsOf(context.spec, { pass: 0.5, partial: 0.2 })),
    evidence: [
      evidenceFrom(
        context,
        CLUSTERS,
        `${spot.length} of ${population.length} clusters use spot or capacity-excess instances`,
        'Interruption-tolerant workloads use discounted capacity rather than on-demand throughout'
      ),
    ],
    outcomeReason:
      'Spot capacity suits interruption-tolerant work and not everything qualifies, so a low share ' +
      'may be a deliberate choice rather than an oversight.',
  };
});

/**
 * CO-03-01: cost attribution.
 *
 * Weighted by money, not by record count. A thousand untagged rows for a trivial job
 * matter less than one untagged row for a warehouse running continuously, and a
 * record count would rank them the other way round.
 */
const costAttribution = fromSignal<CostAttribution>(ATTRIBUTION, ['CO-03-01'], (attribution, context) => {
  // Before the empty-bill branch, for the reason given in CO-01-02 above.
  const barrier = priceBarrier(attribution, 'a tagging share');
  if (barrier != null) return unmeasured(barrier, 'attestation');
  if (attribution.listCost <= 0) {
    return notApplicable('No billable usage was recorded in the window, so there is no spend to attribute.');
  }

  const tagged = share(attribution.customTaggedCost, attribution.listCost);
  const identifiable = share(attribution.identifiableCost, attribution.listCost);

  return {
    outcome: bandOutcome(tagged, bandsOf(context.spec, { pass: 0.8, partial: 0.3 })),
    evidence: [
      evidenceFrom(
        context,
        ATTRIBUTION,
        `${percent(tagged)} of ${money(attribution.listCost, attribution.currency)} spend carries a custom tag` +
          (attribution.tagKeys.length > 0 ? ` (${attribution.tagKeys.join(', ')})` : '') +
          ` (${priceCoverageClause(attribution)})`,
        'Spend carries tags that attribute it to a team, project or cost centre'
      ),
      evidenceFrom(
        context,
        ATTRIBUTION,
        `${percent(identifiable)} is attributable to a specific job, cluster, warehouse, pipeline or endpoint`,
        'Spend can be traced to the resource that incurred it'
      ),
    ],
    outcomeReason:
      identifiable != null && tagged != null && identifiable > tagged
        ? 'Platform-populated resource identifiers cover more spend than customer tags do. Those allow ' +
          'attribution to a resource but not to a team or budget, which is what the tags are for.'
        : undefined,
  };
});

/**
 * CO-01-03: SQL runs on a warehouse rather than on a cluster somebody started to run it.
 *
 * The question this replaces asked whether a warehouse is the path of least resistance. Query history
 * records the path taken, which is the better evidence: an estate where warehouses are easiest is an
 * estate whose SQL ran on them, and one where they are not shows up as interactive clusters.
 *
 * Interactive statements only, and that is the whole reason this reads its own signal rather than the
 * `all_purpose_cost` figure the compute mix already carries. A `MERGE` on a job cluster inside a
 * nightly task is SQL on a cluster and says nothing about what is easy for a person; counting it would
 * mark a heavily orchestrated estate down for orchestrating. So the population is the statements
 * nobody scheduled — no job, no pipeline — which is the population the question is about.
 */
const sqlOnWarehouses = fromSignal<SqlPaths>(SQL_PATHS, ['CO-01-03'], (paths, context) => {
  if (paths.statements === 0) {
    return unmeasured(
      'No SQL ran in the window that this assessment did not run itself, so there is no path to observe. ' +
        'Query history keeps ninety days, so a longer lookback or a workspace with traffic would answer this.',
      'unreadable'
    );
  }
  if (paths.interactiveStatements === 0) {
    return notApplicable(
      `All ${paths.statements} statements in the window were submitted by a job or a pipeline, so nobody ` +
        'chose where to run SQL by hand and there is no path of least resistance to assess.'
    );
  }

  const onWarehouse = share(paths.interactiveWarehouseStatements, paths.interactiveStatements);
  return {
    outcome: bandOutcome(onWarehouse, bandsOf(context.spec, { pass: 0.9, partial: 0.6 })),
    evidence: [
      evidenceFrom(
        context,
        SQL_PATHS,
        `${percent(onWarehouse)} of ${paths.interactiveStatements} statements a person submitted ran on a SQL ` +
          `warehouse, and ${paths.interactiveAllPurposeStatements} on an all-purpose cluster`,
        'Ad-hoc SQL runs on a warehouse rather than on a cluster started to run it'
      ),
      detailFrom(
        context,
        SQL_PATHS,
        `Across everything that ran: ${paths.warehouseStatements} statements on warehouses, ` +
          `${paths.allPurposeStatements} on all-purpose clusters and ${paths.jobClusterStatements} on job ` +
          'clusters, which are the right place for the SQL inside a scheduled task'
      ),
    ],
    outcomeReason:
      paths.unattributedStatements > 0
        ? `${paths.unattributedStatements} statements ran on a cluster this metastore no longer records, so ` +
          'they are in neither share above.'
        : undefined,
  };
});

/**
 * PE-03-10: repeated reads come from cache.
 *
 * Weighted by bytes rather than by statement, because `read_io_cache_percent` is a per-statement
 * percentage and averaging it would give a metadata lookup the same weight as a scan of a terabyte.
 *
 * Statements that read no files are not in the denominator. On the workspace this was measured against,
 * 3,621 of 5,885 statements read nothing at all — served from metadata or from memory — and a hit rate
 * computed over those describes the shape of the workload rather than the effectiveness of the cache.
 */
const caching = fromSignal<SqlPaths>(SQL_PATHS, ['PE-03-10'], (paths, context) => {
  if (paths.statements === 0) {
    return unmeasured(
      'No SQL ran in the window that this assessment did not run itself, so nothing was read and there is ' +
        'no cache behaviour to observe.',
      'unreadable'
    );
  }
  if (paths.fileReadingStatements === 0) {
    return notApplicable(
      `None of ${paths.statements} statements in the window read a file — they were answered from metadata ` +
        'or from memory — so there was nothing for a cache to hold.'
    );
  }

  const cached = share(paths.cachedReadBytes, paths.fileReadBytes);
  return {
    outcome: bandOutcome(cached, bandsOf(context.spec, { pass: 0.5, partial: 0.2 })),
    evidence: [
      evidenceFrom(
        context,
        SQL_PATHS,
        `${percent(cached)} of the bytes read from files came from cache, across ` +
          `${paths.fileReadingStatements} statements that read any`,
        'Repeated reads are served from cache rather than from storage'
      ),
      detailFrom(
        context,
        SQL_PATHS,
        `${paths.resultCacheHits} statements were answered from the result cache without reading anything, ` +
          'so they are outside the figure above rather than counted as a miss'
      ),
    ],
    outcomeReason:
      'A cache share is what was cached, not whether anybody chose it: the disk cache is on by default on ' +
      'most compute. A low share on a workload that reads the same data repeatedly is the finding here; ' +
      'whether the effect was ever measured is the part this cannot see.',
  };
});

/** CO-04-01: continuous streaming costs continuously. Triggered runs cost per run. */
const streamingTriggers = fromSignal<JobRow[]>(JOBS, ['CO-04-01'], (jobs, context) => {
  if (jobs.length === 0)
    return notApplicable('There are no jobs in this workspace, so there is no trigger choice to assess.');

  const continuous = jobs.filter((job) => job.continuous === true);
  if (continuous.length === 0) {
    return {
      outcome: 'pass',
      evidence: [
        evidenceFrom(
          context,
          JOBS,
          `None of ${jobs.length} jobs run continuously`,
          'Streaming work runs on a trigger unless it genuinely needs to be always on'
        ),
      ],
    };
  }

  const ratio = share(continuous.length, jobs.length) ?? 0;
  return {
    outcome: ratio <= threshold(context.spec, 'max_continuous_share', 0.25) ? 'partial' : 'fail',
    evidence: [
      evidenceFrom(
        context,
        JOBS,
        `${continuous.length} of ${jobs.length} jobs run continuously`,
        'Streaming work runs on a trigger unless it genuinely needs to be always on'
      ),
      ...offenders(context, JOBS, 'Always on', continuous, asJob),
    ],
    outcomeReason:
      'Continuous jobs bill for the whole time they are up. Whether that is right depends on the ' +
      'latency the workload needs, which configuration cannot show — confirm each one needs sub-minute freshness.',
  };
});

export const COST_RESOLVERS: readonly ControlResolver[] = [
  dataFormats,
  jobCompute,
  runtimes,
  gpus,
  serverless,
  photon,
  autoscaling,
  autoTermination,
  computePolicies,
  spotUsage,
  costAttribution,
  sqlOnWarehouses,
  caching,
  streamingTriggers,
];

/**
 * The leading integer of a runtime string such as `14.3.x-photon-scala2.12`.
 *
 * Zero when it cannot be read, which makes an unparseable runtime fail the check
 * rather than pass it. An unknown runtime version is not evidence of a current one.
 */
function majorVersion(runtime: string | undefined): number {
  const match = /^(\d+)/.exec(runtime ?? '');
  return match == null ? 0 : Number(match[1]);
}

function describeOldest(stale: readonly ClusterRow[], named: (cluster: ClusterRow) => string): string {
  const oldest = [...stale].sort((a, b) => majorVersion(a.runtime) - majorVersion(b.runtime))[0];
  if (oldest == null) return 'none';
  return `${named(oldest)} on ${oldest.runtime ?? 'an unrecorded runtime'}`;
}
