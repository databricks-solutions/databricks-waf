// Interoperability, and the pillar that was told to answer questions about itself.
//
// All 15 of these controls arrived marked `attestation`, on the assumption that Delta Sharing,
// Lakehouse Federation and recipient configuration were unreachable — their REST APIs need
// scopes no app install can hold (ADR 0016). They are all readable from
// `system.information_schema` with the `sql` scope, so five resolvers now cover nine of them.
//
// What these tests defend is mostly the shape of the absent case, because that is where the
// mistake would repeat. An estate that shares nothing is not failing the sharing control:
// whether to publish data outside the account is a business decision, and scoring its absence
// would be marking an estate down for not having a requirement. An estate with no federated
// connection is not failing either, for a different reason — managed connectors, Auto Loader
// and partner tools all move data without registering one, so the signal is silent rather than
// negative. The two cases read differently on purpose: not-applicable where the requirement
// does not arise, unmeasured where it might and the app cannot see it.

import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../../catalogue/catalogue.js';
import { observed, unmeasurable, type SignalId, type SignalResult } from '../../collect/signal.js';
import type { AssetCensus, LineageCoverage, PlatformCensus } from '../../collect/sql/shapes.js';
import type { ServingInventory, VectorSearchInventory } from '../../collect/rest/shapes.js';
import { resolveControl } from '../resolver.js';
import { buildRegistry } from './index.js';

const CENSUS = 'sql:uc.census' as SignalId;
const PLATFORM = 'sql:uc.platform_census' as SignalId;
const LINEAGE = 'sql:uc.lineage_coverage' as SignalId;
const SERVING = 'rest:workspace:serving-endpoints' as SignalId;
const VECTOR = 'rest:workspace:vector-search.endpoints' as SignalId;

const catalogue = loadCatalogue();
const registry = buildRegistry();

function census(overrides: Partial<AssetCensus> = {}): AssetCensus {
  return {
    tableCount: 100,
    catalogCount: 4,
    schemaCount: 18,
    managedTables: 90,
    externalTables: 10,
    views: 8,
    metricViews: 0,
    foreignTables: 0,
    deltaTables: 98,
    icebergTables: 2,
    optimizedFormatTables: 100,
    describedTables: 90,
    distinctOwners: 5,
    databricksOwnedTables: 0,
    databricksOwnedCatalogs: '',
    ...overrides,
  };
}

function platform(overrides: Partial<PlatformCensus> = {}): PlatformCensus {
  return {
    shares: 0,
    recipients: 0,
    tokenRecipients: 0,
    recipientsWithIpAllowlist: 0,
    providers: 0,
    connections: 0,
    connectionTypes: '',
    externalLocations: 2,
    storageCredentials: 1,
    volumes: 3,
    managedVolumes: 3,
    routines: 4,
    columnMasks: 0,
    rowFilters: 0,
    taggedTables: 0,
    taggedColumns: 0,
    // An owner by default, because the readings above are what an owner sees and the assertions
    // below are about what the app makes of them. The identity that cannot see them is its own
    // case, spelled out where it is tested rather than defaulted into every other one.
    ownsMetastore: true,
    sharingPrivileges: [],
    ...overrides,
  };
}

/** What the scheduled principal reads: not the owner, and granted none of the four. */
function unsighted(overrides: Partial<PlatformCensus> = {}): PlatformCensus {
  return platform({ ownsMetastore: false, sharingPrivileges: [], ...overrides });
}

function lineage(overrides: Partial<LineageCoverage> = {}): LineageCoverage {
  return {
    tableCount: 100,
    tablesWithLineage: 90,
    tablesWrittenWithLineage: 40,
    tablesReadWithLineage: 50,
    lineageEvents: 4_000,
    ...overrides,
  };
}

/** A lineage reading that corroborates an empty metastore rather than contradicting one. */
function empty(): LineageCoverage {
  return lineage({ tableCount: 0, tablesWithLineage: 0, tablesWrittenWithLineage: 0, tablesReadWithLineage: 0, lineageEvents: 0 });
}

function serving(count: number): ServingInventory {
  return {
    endpoints: Array.from({ length: count }, (_, index) => ({
      name: `endpoint-${index}`,
      servedExternalModel: false,
      state: 'READY',
    })),
    truncated: false,
  };
}

function vectorSearch(count: number): VectorSearchInventory {
  return {
    endpoints: Array.from({ length: count }, (_, index) => ({
      name: `vs-${index}`,
      type: 'STANDARD',
      state: 'ONLINE',
    })),
    truncated: false,
  };
}

function findingFor(controlId: string, signals: Map<SignalId, SignalResult>) {
  const spec = catalogue.controls.find((control) => control.id === controlId);
  if (spec == null) throw new Error(`${controlId} is not in the catalogue`);
  return resolveControl(spec, signals, registry.get(controlId));
}

function signalsOf(entries: readonly [SignalId, unknown][]): Map<SignalId, SignalResult> {
  return new Map(entries.map(([id, value]) => [id, observed(id, value, 1, { mode: 'complete' })]));
}

describe('IU-02-02, secure sharing', () => {
  it('passes a metastore sharing outward to recipients', () => {
    const finding = findingFor(
      'IU-02-02',
      signalsOf([[PLATFORM, platform({ shares: 3, recipients: 2, tokenRecipients: 1, recipientsWithIpAllowlist: 1 })]])
    );
    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.observed).toContain('3 shares to 2 recipients');
  });

  it('says the requirement does not arise for an estate that shares nothing', () => {
    // The judgement worth protecting. Sharing is a business decision, and failing an estate
    // for not having made it would be scoring the absence of a requirement.
    const finding = findingFor('IU-02-02', signalsOf([[PLATFORM, platform()]]));
    expect(finding.outcome).toBe('not-applicable');
    expect(finding.outcomeReason).toContain('not a posture defect');
  });

  it('passes a consumer, because consuming through Delta Sharing is the behaviour asked for', () => {
    const finding = findingFor('IU-02-02', signalsOf([[PLATFORM, platform({ providers: 1 })]]));
    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.observed).toContain('publishing nothing outward');
  });

  it('reports a share nobody receives as half-finished rather than as sharing', () => {
    const finding = findingFor('IU-02-02', signalsOf([[PLATFORM, platform({ shares: 2 })]]));
    expect(finding.outcome).toBe('partial');
    expect(finding.outcomeReason).toContain('nothing is actually being shared');
  });

  it('will not call an estate a non-sharer on a reading it was not granted sight of', () => {
    // The defect this row exists for. On labs the same estate, within the hour, read as
    // "consumes shared data" to an admin and "receives none" to the scheduled principal, which
    // could not see the one inbound provider. Three zeroes and three grants, so all three are named.
    const finding = findingFor('IU-02-02', signalsOf([[PLATFORM, unsighted()]]));
    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.unmeasured).toBe('unreadable');
    expect(finding.outcomeReason).toContain('does not own this metastore');
    expect(finding.remedy?.says).toContain('USE SHARE, USE RECIPIENT and USE PROVIDER');
  });

  it('names only the grants that are missing, where some were made', () => {
    const finding = findingFor(
      'IU-02-02',
      signalsOf([[PLATFORM, unsighted({ sharingPrivileges: ['USE_SHARE', 'USE_RECIPIENT'] })]])
    );
    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.remedy?.says).toContain('Grant USE PROVIDER on the metastore');
    expect(finding.remedy?.says).not.toContain('USE SHARE');
  });

  it('will not read a half-finished setup off a reading that is only half granted', () => {
    // The dangerous case, and not the empty one: `USE SHARE` alone shows the shares and hides the
    // recipients, so the branch above would have called a fully-granted estate a setup somebody
    // abandoned — a scored finding rather than a requirement withdrawn, which is worse than the
    // defect this row opened for.
    const finding = findingFor(
      'IU-02-02',
      signalsOf([[PLATFORM, unsighted({ shares: 2, recipients: 0, sharingPrivileges: ['USE_SHARE'] })]])
    );
    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason).toContain('2 Delta Sharing shares, 0 recipients');
    expect(finding.remedy?.says).toContain('Grant USE RECIPIENT and USE PROVIDER');
  });

  it('does not warn about a connection URL in a remedy that asks for no connection grant', () => {
    // The caveat belongs to `USE CONNECTION`. Attached to a remedy asking for the other three, it
    // reads as a reason to decline them.
    const finding = findingFor('IU-02-02', signalsOf([[PLATFORM, unsighted()]]));
    expect(finding.remedy?.says).not.toContain('URL');
  });

  it('trusts the zeroes of an identity granted all three, without it owning anything', () => {
    const finding = findingFor(
      'IU-02-02',
      signalsOf([[PLATFORM, unsighted({ sharingPrivileges: ['USE_SHARE', 'USE_RECIPIENT', 'USE_PROVIDER'] })]])
    );
    expect(finding.outcome).toBe('not-applicable');
  });

  it('reports how the recipients authenticate, without deciding the outcome on it', () => {
    // Recipient authentication is the security pillar's control. It rides along here as
    // detail so a reader is not left to assume a token recipient is an unrestricted one.
    const finding = findingFor(
      'IU-02-02',
      signalsOf([[PLATFORM, platform({ shares: 1, recipients: 4, tokenRecipients: 3, recipientsWithIpAllowlist: 2 })]])
    );
    expect(finding.outcome).toBe('pass');
    expect(finding.evidence.some((item) => (item.observed ?? '').includes('3 of them authenticate'))).toBe(true);
  });
});

describe('IU-01-02, optimized connectors', () => {
  it('passes a metastore with federated connections, and names the sources', () => {
    const finding = findingFor(
      'IU-01-02',
      signalsOf([[PLATFORM, platform({ connections: 2, connectionTypes: 'POSTGRESQL, SNOWFLAKE' })]])
    );
    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.observed).toContain('POSTGRESQL, SNOWFLAKE');
  });

  it('reports no connections as no evidence rather than as bad practice', () => {
    // Auto Loader, managed ingestion connectors and partner tools all register nothing here.
    // An estate ingesting well through any of them is indistinguishable from one ingesting
    // badly, so this goes to a person instead of to a verdict.
    const finding = findingFor('IU-01-02', signalsOf([[PLATFORM, platform()]]));
    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason).toContain('Auto Loader');
    // The census answered, so this is not an access problem and must not be filed as one.
    expect(finding.unmeasured).toBe('attestation');
  });

  it('files an invisible connection as the access problem it is, not as a question', () => {
    // The two zeroes read the same and send the reader to different places: one to a statement
    // their admin can issue, the other to the questionnaire. On labs the scheduled principal read
    // 0 connections where an admin read 1, and got the questionnaire.
    const finding = findingFor('IU-01-02', signalsOf([[PLATFORM, unsighted()]]));
    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.unmeasured).toBe('unreadable');
    expect(finding.remedy?.says).toContain('Grant USE CONNECTION on the metastore');
    expect(finding.outcomeReason).not.toContain('Auto Loader');
  });

  it('goes back to the questionnaire once the grant is in place', () => {
    const finding = findingFor('IU-01-02', signalsOf([[PLATFORM, unsighted({ sharingPrivileges: ['USE_CONNECTION'] })]]));
    expect(finding.unmeasured).toBe('attestation');
  });
});

describe('IU-04-03, a central catalog for discovery', () => {
  it('passes when registration, description and lineage are all healthy', () => {
    const finding = findingFor('IU-04-03', signalsOf([[CENSUS, census()], [LINEAGE, lineage()]]));
    expect(finding.outcome).toBe('pass');
  });

  it('is governed by the weakest of the three, not their average', () => {
    // A fully registered, fully traced estate nobody described is not discoverable. Averaging
    // would let registration carry it.
    const finding = findingFor(
      'IU-04-03',
      signalsOf([[CENSUS, census({ describedTables: 5 })], [LINEAGE, lineage()]])
    );
    expect(finding.outcome).toBe('fail');
    expect(finding.outcomeReason).toContain('weakest link');
  });

  it('leaves lineage out of the verdict when nothing was accessed in the window', () => {
    // An empty lineage population is a quiet fortnight or a freshly enabled audit log, not a
    // lineage graph nobody populated. Scoring it as zero would fail a well-catalogued estate
    // for having had no queries.
    const finding = findingFor('IU-04-03', signalsOf([[CENSUS, census()], [LINEAGE, lineage({ tableCount: 0, tablesWithLineage: 0, tablesReadWithLineage: 0, tablesWrittenWithLineage: 0, lineageEvents: 0 })]]));
    expect(finding.outcome).toBe('pass');
    expect(finding.outcomeReason).toContain('empty population is not a coverage gap');
    expect(finding.evidence.some((item) => (item.observed ?? '').includes('no population to measure'))).toBe(true);
  });

  it('does not score registration, and does not report a registered share', () => {
    // Registration was a third weakest-link factor here, as the share of tables not in
    // `hive_metastore`. That share was structurally always 1.0, so it never bound the verdict and
    // its only effect was a sentence reading "N of N tables registered in Unity Catalog (100%)" —
    // true of the metastore and false of the estate. Discovery is measured on description and
    // lineage, which the census can actually see.
    const observed =
      findingFor('IU-04-03', signalsOf([[CENSUS, census()], [LINEAGE, lineage()]])).evidence[0]?.observed ?? '';
    expect(observed).toContain('100 tables registered in Unity Catalog');
    expect(observed).not.toContain('100%');
    expect(observed).not.toMatch(/\bof 100 tables registered\b/);
  });

  it('counts a table that is both source and target once, not twice', () => {
    // Measured on labs: 7 of 26 distinct tables sat in the source∩target overlap. Summing the
    // per-side counts before clamping inflated coverage by that overlap.
    const observed =
      findingFor(
        'IU-04-03',
        signalsOf([
          [CENSUS, census({ describedTables: 80 })],
          [
            LINEAGE,
            lineage({
              tableCount: 100,
              tablesWithLineage: 70,
              tablesWrittenWithLineage: 40,
              tablesReadWithLineage: 50,
              lineageEvents: 4_000,
            }),
          ],
        ])
      ).evidence.map((item) => item.observed ?? '').join(' ');
    expect(observed).toMatch(/70 of 100 tables appear in lineage/);
    expect(observed).not.toMatch(/90 of 100/);
  });

  it('says the requirement does not apply to a metastore corroborated as empty', () => {
    const finding = findingFor('IU-04-03', signalsOf([[CENSUS, census({ tableCount: 0 })], [LINEAGE, empty()]]));
    expect(finding.outcome).toBe('not-applicable');
  });

  it('declines to call the metastore empty when lineage recorded activity in it', () => {
    // E1d. `system.information_schema` is filtered by the reader's privileges, so a scan run by a
    // principal holding nothing on the customer's catalogs reads zero tables. Excluding the
    // requirement on that reading removes it from the score on a claim the scan cannot make.
    const finding = findingFor('IU-04-03', signalsOf([[CENSUS, census({ tableCount: 0 })], [LINEAGE, lineage()]]));
    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.unmeasured).toBe('unreadable');
    expect(finding.outcomeReason).toContain('4,000 events');
    expect(finding.remedy?.kind).toBe('grant');
    expect(finding.remedy?.says).toContain('BROWSE');
  });
});

describe('IU-04-01 and IU-04-02, data products', () => {
  it('caps at partial with tags in use, because the rest of the requirement is semantic', () => {
    const finding = findingFor(
      'IU-04-01',
      signalsOf([[PLATFORM, platform({ taggedTables: 60, taggedColumns: 20 })], [CENSUS, census()]])
    );
    expect(finding.outcome).toBe('partial');
    expect(finding.outcomeReason).toContain('named the same way across schemas');
  });

  it('fails an untagged estate, because a description is not a claim about status', () => {
    const finding = findingFor('IU-04-02', signalsOf([[PLATFORM, platform()], [CENSUS, census({ describedTables: 20 })]]));
    expect(finding.outcome).toBe('fail');
    expect(finding.outcomeReason).toContain('says whether you should build on it');
  });

  it('holds a well-described but untagged estate at partial rather than failing it', () => {
    // Descriptions are most of the work. An estate that did them and skipped tags has made
    // its assets findable without saying which are safe to build on, which is short of the
    // requirement rather than absent from it.
    const finding = findingFor('IU-04-01', signalsOf([[PLATFORM, platform()], [CENSUS, census({ describedTables: 95 })]]));
    expect(finding.outcome).toBe('partial');
  });

  it('says the requirement does not apply to a metastore corroborated as empty', () => {
    const finding = findingFor(
      'IU-04-01',
      signalsOf([[PLATFORM, platform()], [CENSUS, census({ tableCount: 0 })], [LINEAGE, empty()]])
    );
    expect(finding.outcome).toBe('not-applicable');
  });

  it('declines to call the metastore empty with no corroborating reading at all', () => {
    // The absent-lineage branch of E1d, and the reason it errs this way: the principal this
    // exists for may hold nothing on `system.access` either, so treating a missing cross-check
    // as permission to assert emptiness would leave the defect intact in its own worst case.
    const finding = findingFor('IU-04-01', signalsOf([[PLATFORM, platform()], [CENSUS, census({ tableCount: 0 })]]));
    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.remedy?.says).toContain('BROWSE');
  });
});

describe('IU-03-04, AI capabilities', () => {
  it('passes on serving endpoints alone', () => {
    // Requiring both would fail an estate using Databricks-hosted foundation models through
    // pay-per-token endpoints, which is a reasonable architecture with no vector search in it.
    const finding = findingFor('IU-03-04', signalsOf([[SERVING, serving(3)], [VECTOR, vectorSearch(0)]]));
    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.observed).toBe('3 model serving endpoints');
  });

  it('counts vector search alongside serving when both are present', () => {
    const finding = findingFor('IU-03-04', signalsOf([[SERVING, serving(2)], [VECTOR, vectorSearch(1)]]));
    expect(finding.evidence[0]?.observed).toContain('1 vector search endpoint');
  });

  it('reports no endpoints as no evidence, because most AI surfaces leave none', () => {
    // SQL AI functions, Genie, the assistant and pay-per-token calls are all invisible here.
    // A `fail` would report the app's two readable surfaces as the whole of the platform's AI.
    const finding = findingFor('IU-03-04', signalsOf([[SERVING, serving(0)], [VECTOR, vectorSearch(0)]]));
    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason).toContain('SQL AI functions');
    expect(finding.unmeasured).toBe('attestation');
  });

  it('still answers when vector search was not collected', () => {
    // Vector search is an optional signal: its absence is a scope or a rollout, not a verdict.
    const finding = findingFor(
      'IU-03-04',
      new Map<SignalId, SignalResult>([
        [SERVING, observed(SERVING, serving(1), 1, { mode: 'complete' })],
        [VECTOR, unmeasurable(VECTOR, 'PERMISSION_DENIED')],
      ])
    );
    expect(finding.outcome).toBe('pass');
  });
});

describe('the pillar, as the catalogue now describes it', () => {
  it('measures the nine controls a query can answer, and asks about the rest', () => {
    const measured = ['IU-01-02', 'IU-01-05', 'IU-02-01', 'IU-02-02', 'IU-03-02', 'IU-03-03', 'IU-03-04', 'IU-04-01', 'IU-04-02', 'IU-04-03'];
    for (const id of measured) {
      expect(registry.get(id), `${id} needs a resolver or it goes back on the attestation page`).toBeDefined();
      expect(catalogue.controls.find((control) => control.id === id)?.measurability).not.toBe('attestation');
    }
  });

  it('reports unmeasured rather than a verdict when the platform census is refused', () => {
    for (const id of ['IU-02-02', 'IU-01-02']) {
      // The platform's own wording, not a paraphrase. The remedy is classified from this string,
      // so a fixture saying "query refused" would test the fallback rather than the behaviour.
      const refusal = 'PERMISSION_DENIED: User does not have SELECT on system.information_schema';
      const finding = findingFor(id, new Map([[PLATFORM, unmeasurable(PLATFORM, refusal)]]));
      expect(finding.outcome).toBe('unmeasurable');
      // A refused query and an answered one that settles nothing are the same outcome and
      // completely different advice, so the same control has to report them apart.
      expect(finding.unmeasured).toBe('unreadable');
      expect(finding.remedy?.kind).toBe('grant');
    }
  });
});
