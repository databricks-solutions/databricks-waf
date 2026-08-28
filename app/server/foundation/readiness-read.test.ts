// What the two-pass read does when a statement answers, and what it does when one does not.
//
// The cases below are mostly the second kind. A read that works is one shape and the module is short;
// a read where one of three statements failed is where the distinction this whole family is built on
// gets decided, and it is decidable here and nowhere downstream — once a `[]` has been handed to
// `readiness`, no later layer can tell it from a `null` that should have been passed instead.

import { describe, expect, it } from 'vitest';
import { defineServing } from './serving-asset.js';
import type { ServingDraft } from './serving-asset.js';
import { readReadiness } from './readiness-read.js';
import type { ServingSql } from './readiness-read.js';
import type {
  ServingClassRows,
  ServingFactRows,
  ServingPopulationRows,
  ServingQualityRows,
  ServingTagRows,
} from '../collect/sql/shapes.js';

const DRAFT: ServingDraft = {
  named: [{ catalog: 'main', schema: 'gold', table: 'orders' }],
  tagged: [{ key: 'certification', values: ['gold'], at: ['table'] }],
  requiredTagKeys: ['owner_team'],
  requiredMetadata: ['description', 'owner'],
  policy: [{ classification: 'pii', requires: ['column-mask'] }],
};

function population(overrides: Partial<ServingPopulationRows> = {}): ServingPopulationRows {
  return {
    matchPopulation: 2,
    matches: [
      {
        qualified: 'main.gold.orders',
        catalog: 'main',
        schema: 'gold',
        table: 'orders',
        description: 'Orders as served',
        owner: 'data-platform',
      },
      {
        qualified: 'main.gold.customers',
        catalog: 'main',
        schema: 'gold',
        table: 'customers',
        description: 'Customers as served',
        owner: 'data-platform',
        tagKey: 'certification',
        tagValue: 'gold',
        tagLevel: 'table',
      },
    ],
    ...overrides,
  };
}

function tags(overrides: Partial<ServingTagRows> = {}): ServingTagRows {
  return {
    tagPopulation: 2,
    tags: [
      { qualified: 'main.gold.orders', key: 'owner_team', value: 'platform' },
      { qualified: 'main.gold.customers', key: 'owner_team', value: 'platform' },
    ],
    ...overrides,
  };
}

function fact(qualified: string, overrides: Partial<ServingFactRows['assets'][number]> = {}) {
  return {
    qualified,
    relationKind: 'MANAGED',
    storageFormat: 'DELTA',
    columnCount: 4,
    commentedColumns: 4,
    lineageEvents: 12,
    semanticReaders: 1,
    maskedColumns: 0,
    rowFilters: 0,
    ...overrides,
  };
}

function quality(overrides: Partial<ServingQualityRows> = {}): ServingQualityRows {
  return {
    qualityPopulation: 2,
    statuses: [
      { qualified: 'main.gold.orders', qualityStatus: 'ok' },
      { qualified: 'main.gold.customers', qualityStatus: 'ok' },
    ],
    ...overrides,
  };
}

function classes(overrides: Partial<ServingClassRows> = {}): ServingClassRows {
  return {
    classPopulation: 2,
    classified: [
      { qualified: 'main.gold.orders', classifications: [] },
      { qualified: 'main.gold.customers', classifications: [] },
    ],
    ...overrides,
  };
}

function facts(overrides: Partial<ServingFactRows> = {}): ServingFactRows {
  return {
    assetPopulation: 2,
    assets: [fact('main.gold.orders'), fact('main.gold.customers')],
    ...overrides,
  };
}

/** Five statements that answer, each recording what it was bound to so a test can check the binding. */
function reader(parts: Partial<ServingSql> = {}): ServingSql & { bound: Record<string, string> } {
  const bound: Record<string, string> = {};
  return {
    bound,
    population: (names, tagKeys) => {
      bound['names'] = names;
      bound['tagKeys'] = tagKeys;
      return Promise.resolve(population());
    },
    tags: (assets) => {
      bound['tagAssets'] = assets;
      return Promise.resolve(tags());
    },
    facts: (assets) => {
      bound['factAssets'] = assets;
      return Promise.resolve(facts());
    },
    quality: (assets) => {
      bound['qualityAssets'] = assets;
      return Promise.resolve(quality());
    },
    classes: (assets) => {
      bound['classAssets'] = assets;
      return Promise.resolve(classes());
    },
    ...parts,
  };
}

function dimension(outcome: Awaited<ReturnType<typeof readReadiness>>['outcome'], id: string) {
  const found = outcome.dimensions.find((one) => one.id === id);
  if (found == null) throw new Error(`no ${id} dimension`);
  return found;
}

describe('readReadiness', () => {
  it('binds the second pass to the assets the first pass selected, not to the declaration', async () => {
    // The bound is the whole cost argument. A second pass bound to the declaration would read the
    // catalogue for every tag key it mentions; bound to the population, it reads two rows.
    const sql = reader();
    await readReadiness(defineServing(DRAFT, 1), sql);

    expect(sql.bound['names']).toBe('main.gold.orders');
    expect(sql.bound['tagKeys']).toBe('certification');
    expect(sql.bound['tagAssets']).toBe('main.gold.customers,main.gold.orders');
    expect(sql.bound['factAssets']).toBe('main.gold.customers,main.gold.orders');
  });

  it('runs no statement at all when nothing is declared', async () => {
    let ran = 0;
    const sql = reader({
      population: () => {
        ran += 1;
        return Promise.resolve(population());
      },
    });

    const { outcome, unread } = await readReadiness(null, sql);

    expect(ran).toBe(0);
    expect(unread).toEqual([]);
    expect(outcome.population.undeclared).toBe(true);
  });

  it('reads a declared estate as ready where the facts say so', async () => {
    const { outcome, unread } = await readReadiness(defineServing(DRAFT, 1), reader());

    expect(unread).toEqual([]);
    expect(outcome.population.assets).toBe(2);
    expect(outcome.population.truncated).toBe(false);
    expect(dimension(outcome, 'table-metadata').standing).toBe('ready');
    expect(dimension(outcome, 'storage-format').standing).toBe('ready');
    expect(dimension(outcome, 'lineage').share).toBe(1);
  });

  it('keeps a tag-selected asset in the population when the tag statement fails', async () => {
    // The failure this file exists to get right. `customers` is in the population because of a tag,
    // and the tags the *first* pass read are what put it there. If the failed second pass were allowed
    // to null the whole tag evidence, the population would shrink to one — one unreadable statement
    // turning into an estate that serves fewer tables than it does.
    const { outcome, unread } = await readReadiness(
      defineServing(DRAFT, 1),
      reader({ tags: () => Promise.reject(new Error('warehouse said no')) }),
    );

    expect(outcome.population.assets).toBe(2);
    expect(unread).toEqual([{ statement: 'sql:serving.tags', kind: 'failed', because: 'warehouse said no' }]);
    // Metadata needs the tag keys, so it cannot be read. Everything the facts pass answers still is.
    expect(dimension(outcome, 'table-metadata').standing).toBe('unmeasured');
    expect(dimension(outcome, 'lineage').standing).toBe('ready');
  });

  it('leaves the facts dimensions unmeasured when the facts statement fails, and reads the rest', async () => {
    const { outcome, unread } = await readReadiness(
      defineServing(DRAFT, 1),
      reader({ facts: () => Promise.reject(new Error('timed out')) }),
    );

    expect(unread).toEqual([{ statement: 'sql:serving.facts', kind: 'failed', because: 'timed out' }]);
    for (const id of ['unity-catalog-boundary', 'column-metadata', 'lineage', 'storage-format']) {
      expect(dimension(outcome, id).standing, id).toBe('unmeasured');
      expect(dimension(outcome, id).share, id).toBeNull();
    }
    expect(dimension(outcome, 'table-metadata').standing).toBe('ready');
  });

  it('costs an absent optional schema the two dimensions it feeds, and no others', async () => {
    // Row 65. The two system schemas an account admin enables per metastore feed exactly two of the
    // eight dimensions, and while they were CTEs inside the facts statement an absent one failed that
    // statement at parse time and took the other six down with it — which is what a metastore with
    // neither enabled got, the calibration estate among them.
    //
    // The number is asserted here rather than described anywhere, because it was described: a comment
    // in `scripts/schedule-principal.test.ts` told an operator who grants only what a scan reads that
    // they lose "two of its eight dimensions", and until this split that was six. It is two now, and a
    // test is what keeps it two.
    const { outcome, unread } = await readReadiness(
      defineServing(DRAFT, 1),
      reader({
        quality: () => Promise.reject(new Error('TABLE_OR_VIEW_NOT_FOUND: system.data_quality_monitoring')),
        classes: () => Promise.reject(new Error('TABLE_OR_VIEW_NOT_FOUND: system.data_classification')),
      }),
    );

    expect(unread.map((one) => one.statement).sort()).toEqual(['sql:serving.classes', 'sql:serving.quality']);

    const unmeasured = outcome.dimensions.filter((one) => one.standing === 'unmeasured').map((one) => one.id);
    expect(unmeasured.sort()).toEqual(['policy-controls', 'quality-monitoring']);
    expect(outcome.dimensions).toHaveLength(8);
  });

  it('tells an asset the platform holds no status for from one it could not ask about', async () => {
    // The distinction the split is for, and the one a null could not carry: an absent schema and a
    // recorded absence of quality are different findings, and the second is a dimension a customer has
    // to act on. Same reader, same population, opposite readings.
    const held = await readReadiness(
      defineServing(DRAFT, 1),
      reader({ quality: () => Promise.resolve(quality({ qualityPopulation: 0, statuses: [] })) }),
    );
    expect(dimension(held.outcome, 'quality-monitoring').standing).not.toBe('unmeasured');

    const unasked = await readReadiness(
      defineServing(DRAFT, 1),
      reader({ quality: () => Promise.reject(new Error('TABLE_OR_VIEW_NOT_FOUND')) }),
    );
    expect(dimension(unasked.outcome, 'quality-monitoring').standing).toBe('unmeasured');
  });

  it('does not run the second pass when the first fails, and reports every dimension unmeasured', async () => {
    let second = 0;
    const { outcome, unread } = await readReadiness(
      defineServing(DRAFT, 1),
      reader({
        population: () => Promise.reject(new Error('no grant on information_schema')),
        tags: () => {
          second += 1;
          return Promise.resolve(tags());
        },
        facts: () => {
          second += 1;
          return Promise.resolve(facts());
        },
      }),
    );

    expect(second).toBe(0);
    expect(unread).toEqual([
      { statement: 'sql:serving.population', kind: 'failed', because: 'no grant on information_schema' },
    ]);
    expect(outcome.population.assets).toBe(0);
    expect(dimension(outcome, 'lineage').because).toContain('catalogue was not read');
  });

  it('does not run the second pass when the declaration selected nothing the catalogue holds', async () => {
    let second = 0;
    const { outcome, unread } = await readReadiness(
      defineServing(DRAFT, 1),
      reader({
        population: () => Promise.resolve({ matchPopulation: 0, matches: [] }),
        facts: () => {
          second += 1;
          return Promise.resolve(facts());
        },
      }),
    );

    expect(second).toBe(0);
    expect(unread).toEqual([]);
    expect(outcome.population.missing).toBe(1);
    expect(dimension(outcome, 'lineage').because).toContain('selected no asset the catalogue holds');
  });

  it('reports the outcome as truncated when either read that cuts assets stopped at its cap', async () => {
    const cappedFacts = await readReadiness(
      defineServing(DRAFT, 1),
      reader({ facts: () => Promise.resolve(facts({ assetPopulation: 9_000 })) }),
    );
    expect(cappedFacts.outcome.population.truncated).toBe(true);

    const cappedPopulation = await readReadiness(
      defineServing(DRAFT, 1),
      reader({ population: () => Promise.resolve(population({ matchPopulation: 9_000 })) }),
    );
    expect(cappedPopulation.outcome.population.truncated).toBe(true);

    const whole = await readReadiness(defineServing(DRAFT, 1), reader());
    expect(whole.outcome.population.truncated).toBe(false);
  });

  it('reads a capped tag read as unread, so no asset is short of a key the read did not reach', async () => {
    // The cap falls inside one asset's rows and the read cannot say which, so a required key missing
    // from what came back is missing from the read rather than from the asset. Reported as a shortfall,
    // this would tell a customer their table is untagged on the strength of a row that never arrived —
    // which is the claim `serving_asset_tags.sql` says a truncated read may not make.
    const { outcome, unread } = await readReadiness(
      defineServing(DRAFT, 1),
      reader({
        tags: () =>
          Promise.resolve({
            tagPopulation: 9_000,
            tags: [{ qualified: 'main.gold.orders', key: 'owner_team', value: 'platform' }],
          }),
      }),
    );

    const metadata = dimension(outcome, 'table-metadata');
    expect(metadata.standing).toBe('unmeasured');
    expect(metadata.shortfall).toEqual([]);
    expect(metadata.met).toBe(0);
    expect(unread.map((one) => one.statement)).toEqual(['sql:serving.tags']);
    expect(unread[0]?.because).toContain('stopped at its ceiling');
    // The assets themselves were all read, so the seven dimensions the facts answer are readings of the
    // whole declared population and the outcome must not say otherwise.
    expect(outcome.population.truncated).toBe(false);
    expect(dimension(outcome, 'lineage').standing).toBe('ready');
  });

  it('credits a tag to the asset the population named it against, never to a row it cannot place', async () => {
    // A row for an asset outside the population can only come from a statement bound to a different
    // list. Counting it would satisfy a required key with somebody else's table.
    const { outcome } = await readReadiness(
      defineServing(DRAFT, 1),
      reader({
        tags: () =>
          Promise.resolve({
            tagPopulation: 2,
            tags: [
              { qualified: 'main.gold.orders', key: 'owner_team', value: 'platform' },
              { qualified: 'other.gold.customers', key: 'owner_team', value: 'platform' },
            ],
          }),
      }),
    );

    const metadata = dimension(outcome, 'table-metadata');
    expect(metadata.met).toBe(1);
    expect(metadata.shortfall).toEqual(['main.gold.customers']);
  });

  it('reads a required protection it never queried as unmeasured, not as missing', async () => {
    // ABAC is the one protection no statement here reads, and a matrix may still require it. Reported
    // short, this would tell a customer their classified tables are unprotected on the strength of a
    // source nobody queried — see the absence the outcome carries.
    const abac = defineServing({ ...DRAFT, policy: [{ classification: 'pii', requires: ['abac-policy'] }] }, 1);
    const pii = classes({
      classified: [
        { qualified: 'main.gold.orders', classifications: ['pii'] },
        { qualified: 'main.gold.customers', classifications: ['pii'] },
      ],
    });

    const { outcome } = await readReadiness(abac, reader({ classes: () => Promise.resolve(pii) }));

    const policy = dimension(outcome, 'policy-controls');
    expect(policy.standing).toBe('unmeasured');
    expect(policy.shortfall).toEqual([]);
    expect(outcome.absent.map((one) => one.what)).toContain(
      'whether an ABAC policy covers an asset a rule requires one of',
    );
  });

  it('reads a required protection it did query as missing where the platform records none', async () => {
    const masked = facts({
      assets: [fact('main.gold.orders', { maskedColumns: 2 }), fact('main.gold.customers')],
    });
    const pii = classes({
      classified: [
        { qualified: 'main.gold.orders', classifications: ['pii'] },
        { qualified: 'main.gold.customers', classifications: ['pii'] },
      ],
    });

    const { outcome } = await readReadiness(
      defineServing(DRAFT, 1),
      reader({ facts: () => Promise.resolve(masked), classes: () => Promise.resolve(pii) }),
    );

    const policy = dimension(outcome, 'policy-controls');
    expect(policy.met).toBe(1);
    expect(policy.shortfall).toEqual(['main.gold.customers']);
  });

  it('drops a tag whose level the statement did not spell, rather than guessing at a table tag', async () => {
    // Guessing `table` would put somebody else's catalog tag on this table, which is the one wrong
    // guess that changes a population: `certification` at catalog level is not in the declaration's
    // `at`, and a catalog tag read as a table tag would select an asset the declaration does not.
    const { outcome } = await readReadiness(
      defineServing(DRAFT, 1),
      reader({
        population: () =>
          Promise.resolve({
            matchPopulation: 1,
            matches: [
              {
                qualified: 'main.gold.customers',
                catalog: 'main',
                schema: 'gold',
                table: 'customers',
                description: null,
                owner: null,
                tagKey: 'certification',
                tagValue: 'gold',
                tagLevel: 'metastore',
              },
            ],
          }),
      }),
    );

    // Nothing selected it, and `orders` was named but not returned, so the population is empty.
    expect(outcome.population.assets).toBe(0);
    expect(outcome.population.missing).toBe(1);
  });
});
