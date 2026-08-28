// Interoperability and usability resolvers.
//
// Like operational excellence, this pillar arrived entirely marked `attestation`. Most of
// it turned out to be measurable, and from a surface the app was wrongly assumed not to
// reach: Delta Sharing, Lakehouse Federation and recipient configuration are all readable
// through `system.information_schema` with the `sql` scope, even though the REST APIs for
// the same objects need scopes Databricks Apps does not offer (ADR 0016). That mistake is
// worth naming, because it was a whole pillar told to answer questions about itself when
// the answers were one query away.
//
// What genuinely stays a question for a person: whether the integration patterns chosen are
// the standard ones, whether partner tools are certified, and whether a published data
// product is one the business trusts. Those are judgements about intent, and no amount of
// metastore reading settles them.

import type { ControlResolver } from '../resolver.js';
import type { AssetCensus, LineageCoverage, PlatformCensus } from '../../collect/sql/shapes.js';
import type { ServingInventory, VectorSearchInventory } from '../../collect/rest/shapes.js';
import { share } from '../../collect/sql/rows.js';
import {
  bandOutcome,
  bandsOf,
  detailFrom,
  enrichedBy,
  evidenceFrom,
  fromSignal,
  fromSignals,
  notApplicable,
  observedValue,
  percent,
  sourcedFrom,
  unmeasured,
  valueOf,
} from './helpers.js';
import { unestablishedEmptiness, unestablishedSharing, VISIBILITY_CROSS_CHECK } from './visibility.js';

const CENSUS = 'sql:uc.census';
const PLATFORM = 'sql:uc.platform_census';
const LINEAGE = 'sql:uc.lineage_coverage';
const SERVING = 'rest:workspace:serving-endpoints';
const VECTOR = 'rest:workspace:vector-search.endpoints';

/**
 * IU-02-02: secure data and AI sharing.
 *
 * Measured from `system.information_schema.shares` rather than the Delta Sharing REST API,
 * which needs the `sharing` scope no app install can hold. Both halves matter: a share with
 * no recipient publishes to nobody, and a recipient with no share receives nothing, so an
 * estate with one and not the other has started rather than finished.
 *
 * An estate that shares nothing is not failing this control. Sharing is a business
 * decision, and marking an estate down for not having made it would be scoring the absence
 * of a requirement. That is `not-applicable` with the reason said out loud.
 *
 * Which requires all three readings to be this estate's and not this reader's, and the check for
 * that comes before any of them is compared to zero rather than only before the all-zero case. Each
 * is filtered by its own metastore grant, so a partly-granted identity is the dangerous one: holding
 * `USE SHARE` and not `USE RECIPIENT` it reads shares against no recipients and the branch below
 * would score the estate `partial` for a half-finished setup that is fully finished. On labs a
 * scheduled principal read this control as "receives none" on the same estate, in the same hour,
 * that an admin read as "consumes shared data" — one inbound provider, invisible to it.
 */
const secureSharing = fromSignal<PlatformCensus>(PLATFORM, ['IU-02-02'], (platform, context) => {
  const unseen = unestablishedSharing(
    platform,
    ['shares', 'recipients', 'providers'],
    `${platform.shares} Delta Sharing share${platform.shares === 1 ? '' : 's'}, ` +
      `${platform.recipients} recipient${platform.recipients === 1 ? '' : 's'} and ` +
      `${platform.providers} inbound provider${platform.providers === 1 ? '' : 's'}`
  );
  if (unseen != null) return unseen;

  const sharing = platform.shares > 0 || platform.recipients > 0 || platform.providers > 0;
  if (!sharing) {
    return notApplicable(
      'This metastore publishes no Delta Sharing shares and receives none, so there is no sharing ' +
        'configuration to assess. Nothing here says sharing should be set up: whether to share data ' +
        'outside the account is a business decision, not a posture defect.'
    );
  }

  if (platform.shares === 0) {
    return {
      outcome: 'pass',
      evidence: [
        evidenceFrom(
          context,
          PLATFORM,
          `${platform.providers} inbound provider${platform.providers === 1 ? '' : 's'}, publishing nothing outward`,
          'Data leaving or entering the account travels through Delta Sharing rather than copies'
        ),
      ],
      outcomeReason:
        'This metastore consumes shared data but publishes none, so the outbound controls — recipient ' +
        'authentication and token allowlists — have nothing to govern. Consuming through Delta Sharing is ' +
        'itself the open-interface behaviour this control asks for.',
    };
  }

  // A share nobody receives is the half-finished case, and it is worth its own outcome:
  // the work of defining what to share is done and the work of granting it is not.
  if (platform.recipients === 0) {
    return {
      outcome: 'partial',
      evidence: [
        evidenceFrom(
          context,
          PLATFORM,
          `${platform.shares} share${platform.shares === 1 ? '' : 's'} defined, with no recipients`,
          'Shares are granted to recipients, so what is defined is actually reachable'
        ),
      ],
      outcomeReason:
        'Shares exist but no recipient can read them, so nothing is actually being shared. This is either ' +
        'a setup someone did not finish or shares kept for a consumer who has not been onboarded.',
    };
  }

  return {
    outcome: 'pass',
    evidence: [
      evidenceFrom(
        context,
        PLATFORM,
        `${platform.shares} share${platform.shares === 1 ? '' : 's'} to ${platform.recipients} recipient` +
          `${platform.recipients === 1 ? '' : 's'}` +
          (platform.providers > 0 ? `, plus ${platform.providers} inbound provider${platform.providers === 1 ? '' : 's'}` : ''),
        'Data leaving or entering the account travels through Delta Sharing rather than copies'
      ),
      ...(platform.tokenRecipients > 0
        ? [
            detailFrom(
              context,
              PLATFORM,
              `${platform.tokenRecipients} of them authenticate with a bearer token, ` +
                `${platform.recipientsWithIpAllowlist} with an IP allowlist`
            ),
          ]
        : []),
    ],
    outcomeReason:
      'Sharing is configured and reachable. Whether the right data is shared with the right party is not ' +
      'something the metastore can answer — the security pillar measures how those recipients ' +
      'authenticate.',
  };
});

/**
 * IU-01-02: optimized connectors for external sources.
 *
 * Lakehouse Federation connections are the observable form: a federated connection queries
 * the source in place, with pushdown, instead of a hand-written extract landing files.
 *
 * The catch is that a connection's absence is not evidence of a defect. Managed ingestion
 * connectors, partner tools and Auto Loader all bring data in without appearing here, so
 * an estate with none is unmeasured rather than failing.
 */
const optimizedConnectors = fromSignal<PlatformCensus>(PLATFORM, ['IU-01-02'], (platform, context) => {
  // Before the count is read at all, for the same reason as IU-02-02 above: a reading this identity
  // was not granted supports none of the verdicts below, not only the empty one.
  //
  // The milder of this row's two cases and still worth separating, because the two zeroes send the
  // reader to different places. A connection this identity was not granted sight of is an access
  // problem with a statement that fixes it; a managed ingestion connector is invisible to every
  // identity and is a question for a person. Until E1f these were the same sentence, and the comment
  // that justified it said no grant makes a connection visible — true of the managed connectors,
  // false of the census view it was written above, where `USE CONNECTION` does.
  const unseen = unestablishedSharing(
    platform,
    ['connections'],
    `${platform.connections} Lakehouse Federation connection${platform.connections === 1 ? '' : 's'}`
  );
  if (unseen != null) return unseen;

  if (platform.connections === 0) {
    return unmeasured(
      'No Lakehouse Federation connections exist in this metastore, which does not mean external data is ' +
        'being moved badly. Managed ingestion connectors, Auto Loader and partner tools all bring data in ' +
        'without registering a connection, and none of them are visible here. Answer the attestation to ' +
        'record which of them is in use.',
      'attestation'
    );
  }

  return {
    outcome: 'pass',
    evidence: [
      evidenceFrom(
        context,
        PLATFORM,
        `${platform.connections} federated connection${platform.connections === 1 ? '' : 's'}` +
          (platform.connectionTypes !== '' ? ` (${platform.connectionTypes})` : ''),
        'External sources are reached through governed connectors rather than hand-written extracts'
      ),
    ],
    outcomeReason:
      'A federated connection queries the source where it lives, with predicate pushdown and Unity ' +
      'Catalog permissions, instead of a scheduled extract that has to be maintained and reconciled.',
  };
});

/**
 * IU-04-03: a central catalog for discovery and lineage.
 *
 * Two things together, because a catalogue nobody can search and a lineage graph nobody
 * populates are both failures of the same requirement: assets described well enough to be
 * found, with their flow visible.
 *
 * It was three until 2026-08-05, the third being the share of tables registered in Unity
 * Catalog rather than left in `hive_metastore`. That share was structurally always 1.0, so it
 * never once bound the minimum below — see the note in the body — and registration is now a
 * property of every table the census can see rather than something scored.
 *
 * Descriptions and lineage each have their own control elsewhere in the catalogue (DG-01-05
 * and DG-01-04), so this reads them as inputs to a discovery verdict rather than
 * re-scoring them. The weaker of the two governs, since discovery fails at its weakest link.
 */
const centralCatalog = fromSignals([CENSUS, LINEAGE], ['IU-04-03'], (context) => {
  const census = valueOf<AssetCensus>(context, CENSUS);
  const lineage = valueOf<LineageCoverage>(context, LINEAGE);

  if (census.tableCount === 0) {
    // Both readings are already required here, so the cross-check needs no enrichment.
    return (
      unestablishedEmptiness(context) ??
      notApplicable('This metastore contains no tables, so there is nothing to discover yet.')
    );
  }

  // Registration used to be a third factor here, as the share of tables not in `hive_metastore`.
  // That share was structurally always 1.0 — the census cannot see the legacy catalog — so it
  // never once bound the weakest link below, and its only effect was a sentence reading "N of N
  // tables registered in Unity Catalog (100%)" on estates where that was untrue. Discovery is now
  // measured on the two factors the census can actually see.
  const described = share(census.describedTables, census.tableCount);
  const touched = Math.min(lineage.tableCount, lineage.tablesWithLineage);
  // An empty lineage population is not a lineage graph nobody populated — it is a window in
  // which the audit table recorded no table access at all, which happens on a quiet estate
  // and on one whose audit delivery has only just been switched on. Scoring that as zero
  // would fail a fully catalogued estate for having had a quiet fortnight, so lineage drops
  // out of the verdict and the reason says it did.
  const traced = lineage.tableCount > 0 ? share(touched, lineage.tableCount) : undefined;

  // The weakest link governs. Averaging them would let an estate with a well-populated lineage
  // graph and no descriptions pass on the strength of the traceable half, and an asset nobody can
  // tell the purpose of is not discoverable however well its flow is recorded.
  const measured = [described, traced].filter((value): value is number => value != null);
  const weakest = measured.length > 0 ? Math.min(...measured) : 0;

  return {
    outcome: bandOutcome(weakest, bandsOf(context.spec, { pass: 0.7, partial: 0.3 })),
    evidence: [
      evidenceFrom(
        context,
        CENSUS,
        `${census.tableCount} tables registered in Unity Catalog, ${census.describedTables} of them ` +
          `described (${percent(described)})`,
        'Assets are registered in one catalogue and described well enough to be found'
      ),
      evidenceFrom(
        context,
        LINEAGE,
        traced == null
          ? 'No table access was recorded in the window, so lineage coverage has no population to measure'
          : `${touched} of ${lineage.tableCount} tables appear in lineage (${percent(traced)})`,
        'Data flow between assets is visible, so a consumer can see where a table comes from'
      ),
    ],
    outcomeReason:
      'Scored on the weaker of description and lineage rather than their average, because discovery fails ' +
      'at its weakest link: a registered table nobody described is not findable, and a well-described one ' +
      'with no lineage cannot be traced to its source. Registration itself is not scored — every table ' +
      'counted here is registered in Unity Catalog by virtue of being visible to the census, and whether ' +
      'anything sits outside it is beyond what this assessment measures.' +
      (traced == null
        ? ' Lineage is left out of this verdict, because no table access was recorded in the window at all ' +
          'and an empty population is not a coverage gap.'
        : ''),
  };
});

/**
 * IU-04-01 and IU-04-02: reusable, semantically consistent data products.
 *
 * The observable half is that assets carry the metadata a consumer needs to trust them —
 * a description, a tag marking their status, an owner. Whether the business actually trusts
 * them, and whether "customer" means the same thing in two schemas, are not readable.
 *
 * So this caps at partial and says which part it measured. Tags matter more than
 * descriptions here: a description says what a table is, a tag says what it is *for* —
 * certified, deprecated, restricted — which is the claim a data product makes.
 */
// The cross-check is an enrichment rather than a requirement: an unread lineage signal must not
// take this control unmeasurable on its own, and `unestablishedEmptiness` already declines to
// assert emptiness when it is absent, with the remedy that says what to grant.
const dataProducts = enrichedBy(
  [VISIBILITY_CROSS_CHECK],
  sourcedFrom(
    [CENSUS],
    fromSignal<PlatformCensus>(PLATFORM, ['IU-04-01', 'IU-04-02'], (platform, context) => {
      const census = observedValue<AssetCensus>(context, CENSUS);
      if (census == null || census.tableCount === 0) {
        return (
          unestablishedEmptiness(context) ??
          notApplicable(
            'This metastore contains no tables, so there are no data products to publish. ' +
              'Ownership and tagging apply once there are assets to own.'
          )
        );
      }

      const described = share(census.describedTables, census.tableCount);
      const tagged = share(platform.taggedTables, census.tableCount);

      if (platform.taggedTables === 0) {
        return {
          outcome: described != null && described >= 0.8 ? 'partial' : 'fail',
          evidence: [
            evidenceFrom(
              context,
              PLATFORM,
              `No tables carry a tag, against ${census.describedTables} of ${census.tableCount} carrying a ` +
                `description (${percent(described)})`,
              'Published assets are tagged with their status, so a consumer can tell a product from a working table'
            ),
          ],
          outcomeReason:
            'Without tags there is nothing in the metastore that distinguishes a table published as a ' +
            'product from a staging table someone left behind. A description says what a table is; a tag ' +
            'says whether you should build on it.',
        };
      }

      return {
        outcome: 'partial',
        evidence: [
          evidenceFrom(
            context,
            PLATFORM,
            `${platform.taggedTables} of ${census.tableCount} tables tagged (${percent(tagged)}), ` +
              `${platform.taggedColumns} tagged columns`,
            'Published assets are tagged with their status, so a consumer can tell a product from a working table'
          ),
          detailFrom(
            context,
            PLATFORM,
            `${census.describedTables} tables described, ${census.distinctOwners} distinct owners, ` +
              `${platform.routines} registered function${platform.routines === 1 ? '' : 's'}`
          ),
        ],
        outcomeReason:
          'Tagging and descriptions are in use, which is the metadata a data product needs. This caps at ' +
          'partial because the rest of the requirement is semantic: whether the same business concept is ' +
          'named the same way across schemas, and whether the business actually trusts these assets, is ' +
          'not something the metastore records.',
      };
    })
  )
);

/**
 * IU-03-04: AI capabilities in use.
 *
 * Serving endpoints and vector search indexes are read from the REST surface, which the app
 * does hold scopes for — `model-serving` and `vector-search` are both grantable, which is
 * why this control is measured while most of the security pillar's REST controls are not.
 *
 * Both signals are optional rather than required: an estate using Databricks-hosted
 * foundation models through the pay-per-token endpoints has serving endpoints and no vector
 * search, and demanding both would fail it for a reasonable architecture.
 */
const aiCapabilities = sourcedFrom(
  [VECTOR],
  fromSignals([SERVING], ['IU-03-04'], (context) => {
    const serving = valueOf<ServingInventory>(context, SERVING);
    const vector = observedValue<VectorSearchInventory>(context, VECTOR);
    const endpoints = serving.endpoints.length;
    const indexes = vector?.endpoints.length ?? 0;

    // Reported as no evidence rather than as a failure, because the endpoints are only two of
    // the ways this requirement is met. SQL AI functions, Genie, the assistant and
    // foundation-model pay-per-token calls all leave no endpoint behind, so an estate using
    // those heavily is indistinguishable from one using no AI at all on this signal. Failing
    // it would be reporting the limits of the evidence as a defect in the estate.
    if (endpoints === 0 && indexes === 0) {
      return unmeasured(
        'No model serving or vector search endpoints exist, which is not the same as no AI in use. Those ' +
          'two are the only AI surfaces an app can be authorised to read; SQL AI functions, Genie, the ' +
          'assistant and pay-per-token foundation model calls all leave no endpoint behind and are invisible ' +
          'here. Answer the attestation to record which of them is in play.',
        'attestation'
      );
    }

    return {
      outcome: 'pass',
      evidence: [
        evidenceFrom(
          context,
          SERVING,
          `${endpoints} model serving endpoint${endpoints === 1 ? '' : 's'}` +
            (indexes > 0 ? ` and ${indexes} vector search endpoint${indexes === 1 ? '' : 's'}` : ''),
          'The platform’s AI capabilities are used to shorten delivery rather than rebuilt elsewhere'
        ),
      ],
    };
  })
);

export const INTEROPERABILITY_RESOLVERS: readonly ControlResolver[] = [
  secureSharing,
  optimizedConnectors,
  centralCatalog,
  dataProducts,
  aiCapabilities,
];
