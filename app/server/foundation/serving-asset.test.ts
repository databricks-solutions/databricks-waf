import { describe, expect, it } from 'vitest';
import {
  defineServing,
  metadataReadings,
  policyReadings,
  qualify,
  servingPopulation,
  ServingDefinitionError,
  type AssetName,
  type CataloguedAsset,
  type ServingDraft,
  type ServingEvidence,
  type TagFact,
} from './serving-asset.js';

function name(catalog: string, schema: string, table: string): AssetName {
  return { catalog, schema, table };
}

function asset(catalog: string, schema: string, table: string, held: Partial<CataloguedAsset> = {}): CataloguedAsset {
  return { name: name(catalog, schema, table), ...held };
}

function tableTag(catalog: string, schema: string, table: string, key: string, value: string): TagFact {
  return { on: { level: 'table', catalog, schema, table }, key, value };
}

function evidence(over: Partial<ServingEvidence> = {}): ServingEvidence {
  return { catalogued: [], tags: [], classifications: [], protections: [], ...over };
}

const GOLD: ServingDraft = { tagged: [{ key: 'certification', values: ['gold'], at: ['table'] }] };

describe('a name classifies nothing', () => {
  // The whole point of the module, from the four directions a name could get in. Each of these estates
  // is one somebody would look at and call obviously gold, and the definition says none of them are.
  const definition = defineServing(GOLD, 1);

  const namedLikeGold: readonly CataloguedAsset[] = [
    asset('gold', 'sales', 'orders'),
    asset('main', 'gold', 'orders'),
    asset('main', 'sales', 'gold_orders'),
    asset('main', 'gold_zone', 'certified_customers'),
  ];

  it('classifies no asset from its catalog, schema or table name', () => {
    const population = servingPopulation(definition, evidence({ catalogued: namedLikeGold }));

    expect(population.assets).toEqual([]);
  });

  it('classifies nothing from a tag value alone, under a key the definition does not name', () => {
    // The near miss: the estate does carry the word, on a key nobody selected on. `45a` counted 2,046
    // distinct tag keys on one metastore, so matching a value across keys would classify by coincidence.
    const population = servingPopulation(
      definition,
      evidence({
        catalogued: [asset('main', 'sales', 'orders')],
        tags: [tableTag('main', 'sales', 'orders', 'layer', 'gold')],
      }),
    );

    expect(population.assets).toEqual([]);
  });

  it('classifies nothing from a tag key whose value is not one the selector accepts', () => {
    const population = servingPopulation(
      definition,
      evidence({
        catalogued: [asset('main', 'sales', 'orders')],
        tags: [tableTag('main', 'sales', 'orders', 'certification', 'deprecated')],
      }),
    );

    expect(population.assets).toEqual([]);
  });

  it('classifies nothing from a tag at a level the selector does not accept', () => {
    // A schema tagged gold does not make its tables gold unless the definition said schemas count. The
    // claim "every table under this" is larger than "this table", and it has to be made deliberately.
    const population = servingPopulation(
      definition,
      evidence({
        catalogued: [asset('main', 'sales', 'orders')],
        tags: [{ on: { level: 'schema', catalog: 'main', schema: 'sales' }, key: 'certification', value: 'gold' }],
      }),
    );

    expect(population.assets).toEqual([]);
  });

  it('refuses a definition that names a pattern rather than an asset', () => {
    expect(() => defineServing({ named: [name('main', 'gold', '*')] }, 1)).toThrow(ServingDefinitionError);
    expect(() => defineServing({ named: [name('main', 'gold%', 'orders')] }, 1)).toThrow(/wildcard or a quote/u);
  });

  it('refuses a name pasted with its quoting, rather than silently never matching it', () => {
    expect(() => defineServing({ named: [name('`main`', '`sales`', '`orders`')] }, 1)).toThrow(
      ServingDefinitionError,
    );
  });
});

describe('the population', () => {
  it('takes a named asset, and says why it is in', () => {
    const definition = defineServing({ named: [name('main', 'sales', 'orders')] }, 1);
    const population = servingPopulation(definition, evidence({ catalogued: [asset('main', 'sales', 'orders')] }));

    expect(population.assets).toEqual([
      { name: name('main', 'sales', 'orders'), qualified: 'main.sales.orders', because: { kind: 'named' } },
    ]);
  });

  it('takes a tagged asset, and says which tag put it there', () => {
    const definition = defineServing(GOLD, 1);
    const population = servingPopulation(
      definition,
      evidence({
        catalogued: [asset('main', 'sales', 'orders'), asset('main', 'sales', 'staging')],
        tags: [tableTag('main', 'sales', 'orders', 'certification', 'gold')],
      }),
    );

    expect(population.assets).toEqual([
      {
        name: name('main', 'sales', 'orders'),
        qualified: 'main.sales.orders',
        because: { kind: 'tagged', key: 'certification', value: 'gold', at: 'table' },
      },
    ]);
  });

  it('spreads a schema tag over the schema, where the selector accepts one', () => {
    const definition = defineServing({ tagged: [{ key: 'data_product', at: ['schema'] }] }, 1);
    const population = servingPopulation(
      definition,
      evidence({
        catalogued: [asset('main', 'sales', 'orders'), asset('main', 'sales', 'refunds'), asset('main', 'raw', 'events')],
        tags: [{ on: { level: 'schema', catalog: 'main', schema: 'sales' }, key: 'data_product', value: 'billing' }],
      }),
    );

    expect(population.assets.map((one) => one.qualified)).toEqual(['main.sales.orders', 'main.sales.refunds']);
  });

  it('matches whatever case the estate or the customer wrote', () => {
    const definition = defineServing({ named: [name('Main', 'Sales', 'Orders')], ...GOLD }, 1);
    const population = servingPopulation(
      definition,
      evidence({
        catalogued: [asset('main', 'sales', 'orders'), asset('main', 'sales', 'refunds')],
        tags: [tableTag('MAIN', 'SALES', 'REFUNDS', 'Certification', 'Gold')],
      }),
    );

    expect(population.assets.map((one) => one.qualified)).toEqual(['main.sales.orders', 'main.sales.refunds']);
  });

  it('reports a named asset the catalogue does not hold, rather than dropping it', () => {
    const definition = defineServing({ named: [name('main', 'sales', 'orders'), name('main', 'sales', 'gone')] }, 1);
    const population = servingPopulation(definition, evidence({ catalogued: [asset('main', 'sales', 'orders')] }));

    expect(population.assets).toHaveLength(1);
    expect(population.missing).toEqual([name('main', 'sales', 'gone')]);
  });

  it('reports nothing missing when the catalogue was not read at all', () => {
    const definition = defineServing({ named: [name('main', 'sales', 'orders')] }, 1);
    const population = servingPopulation(definition, evidence({ catalogued: null }));

    expect(population.missing).toEqual([]);
    expect(population.catalogueUnread).toBe(true);
  });

  it('says tags were unread rather than reporting an untagged estate', () => {
    const population = servingPopulation(defineServing(GOLD, 1), evidence({ catalogued: [asset('main', 's', 't')], tags: null }));

    expect(population.assets).toEqual([]);
    expect(population.tagsUnread).toBe(true);
  });

  it('gives the nearest tag as the reason, whatever order the rows came back in', () => {
    const definition = defineServing(
      {
        tagged: [
          { key: 'certification', values: ['gold'], at: ['table', 'schema'] },
          { key: 'data_product', at: ['schema'] },
        ],
      },
      1,
    );
    const table = tableTag('main', 'sales', 'orders', 'certification', 'gold');
    const schema: TagFact = {
      on: { level: 'schema', catalog: 'main', schema: 'sales' },
      key: 'data_product',
      value: 'billing',
    };
    const catalogued = [asset('main', 'sales', 'orders')];

    for (const tags of [
      [table, schema],
      [schema, table],
    ]) {
      const population = servingPopulation(definition, evidence({ catalogued, tags }));
      expect(population.assets[0]?.because).toEqual({
        kind: 'tagged',
        key: 'certification',
        value: 'gold',
        at: 'table',
      });
    }
  });

  it('prefers the reason a reader can act on, where an asset is both named and tagged', () => {
    const definition = defineServing({ named: [name('main', 'sales', 'orders')], ...GOLD }, 1);
    const population = servingPopulation(
      definition,
      evidence({
        catalogued: [asset('main', 'sales', 'orders')],
        tags: [tableTag('main', 'sales', 'orders', 'certification', 'gold')],
      }),
    );

    expect(population.assets.map((one) => one.because.kind)).toEqual(['named']);
  });
});

describe('defining one', () => {
  it('refuses a definition that declares nothing served', () => {
    expect(() => defineServing({}, 1)).toThrow(/would declare nothing to be served/u);
  });

  it('refuses a selector that accepts no value, which could never match', () => {
    expect(() => defineServing({ tagged: [{ key: 'certification', values: [], at: ['table'] }] }, 1)).toThrow(
      /can never match/u,
    );
  });

  it('refuses a selector that says nowhere the tag may be', () => {
    expect(() => defineServing({ tagged: [{ key: 'certification', at: [] }] }, 1)).toThrow(/at least one of/u);
  });

  it('refuses a selector whose levels are none this build knows, rather than storing one that never matches', () => {
    // Parsed rather than written, because that is how one arrives: the type refuses this at compile
    // time and a definition read back from a store or a request body has not been near the compiler.
    const stored: unknown = JSON.parse('{"tagged":[{"key":"certification","at":["column"]}]}');

    expect(() => defineServing(stored as ServingDraft, 1)).toThrow(/names no level this build knows/u);
  });

  it('refuses two selectors on one key rather than choosing between them', () => {
    expect(() =>
      defineServing(
        {
          tagged: [
            { key: 'certification', values: ['gold'], at: ['table'] },
            { key: 'certification', values: ['silver'], at: ['schema'] },
          ],
        },
        1,
      ),
    ).toThrow(/selected on twice/u);
  });

  it('refuses two rules for one classification', () => {
    expect(() =>
      defineServing(
        {
          ...GOLD,
          policy: [
            { classification: 'pii', requires: ['column-mask'] },
            { classification: 'PII', requires: ['row-filter'] },
          ],
        },
        1,
      ),
    ).toThrow(/two rules for pii/u);
  });

  it('refuses a rule that requires no protection', () => {
    expect(() => defineServing({ ...GOLD, policy: [{ classification: 'pii', requires: [] }] }, 1)).toThrow(
      /requires no protection/u,
    );
  });

  it('collapses an asset named twice, and keeps the sets in canonical order', () => {
    const definition = defineServing(
      {
        named: [name('main', 'sales', 'orders'), name('MAIN', 'SALES', 'ORDERS'), name('main', 'a', 'b')],
        requiredTagKeys: ['owner_team', 'Owner_Team', 'domain'],
      },
      1,
    );

    expect(definition.named.map(qualify)).toEqual(['main.a.b', 'main.sales.orders']);
    expect(definition.requiredTagKeys).toEqual(['domain', 'owner_team']);
  });

  it('fingerprints what it declares rather than how it was written', () => {
    const one = defineServing({ named: [name('main', 'a', 'b'), name('main', 'c', 'd')], requiredMetadata: ['owner', 'description'] }, 1);
    const other = defineServing({ named: [name('main', 'c', 'd'), name('main', 'a', 'b')], requiredMetadata: ['description', 'owner'] }, 2);

    expect(one.fingerprint).toBe(other.fingerprint);
  });

  it('refuses a version that is not a version', () => {
    expect(() => defineServing(GOLD, 0)).toThrow(ServingDefinitionError);
  });
});

describe('the metadata half, which applies to everything served', () => {
  const definition = defineServing(
    { ...GOLD, requiredTagKeys: ['owner_team'], requiredMetadata: ['description', 'owner'] },
    1,
  );

  function read(held: Partial<CataloguedAsset>, tags: readonly TagFact[]) {
    const catalogued = [{ name: name('main', 'sales', 'orders'), ...held }];
    const facts = [tableTag('main', 'sales', 'orders', 'certification', 'gold'), ...tags];
    const evidenceRead = evidence({ catalogued, tags: facts });
    return metadataReadings(definition, servingPopulation(definition, evidenceRead), evidenceRead);
  }

  it('is met where the asset carries every required key and field', () => {
    const [reading] = read({ description: 'Order lines', owner: 'sales-eng' }, [
      tableTag('main', 'sales', 'orders', 'owner_team', 'sales-eng'),
    ]);

    expect(reading).toMatchObject({ standing: 'met', missingTagKeys: [], missingMetadata: [] });
  });

  it('is short of the keys the asset does not carry', () => {
    const [reading] = read({ description: 'Order lines', owner: 'sales-eng' }, []);

    expect(reading).toMatchObject({ standing: 'short', missingTagKeys: ['owner_team'] });
  });

  it('counts a blank description as absent and a missing column as unread', () => {
    const [blank] = read({ description: '   ', owner: 'sales-eng' }, [
      tableTag('main', 'sales', 'orders', 'owner_team', 'sales-eng'),
    ]);
    expect(blank).toMatchObject({ standing: 'short', missingMetadata: ['description'] });

    const [unread] = read({ owner: 'sales-eng' }, [tableTag('main', 'sales', 'orders', 'owner_team', 'sales-eng')]);
    expect(unread).toMatchObject({ standing: 'unmeasured', unread: ['description'] });
  });

  it('does not read a required key off the schema the asset sits in', () => {
    // The tag that made it serving may sit on the schema; a required key on the asset is about the
    // asset. Inheriting here would report a whole schema as carrying keys one tag supplied.
    const definitionAtSchema = defineServing(
      { tagged: [{ key: 'certification', values: ['gold'], at: ['schema'] }], requiredTagKeys: ['owner_team'] },
      1,
    );
    const evidenceRead = evidence({
      catalogued: [asset('main', 'sales', 'orders')],
      tags: [
        { on: { level: 'schema', catalog: 'main', schema: 'sales' }, key: 'certification', value: 'gold' },
        { on: { level: 'schema', catalog: 'main', schema: 'sales' }, key: 'owner_team', value: 'sales-eng' },
      ],
    });

    const [reading] = metadataReadings(
      definitionAtSchema,
      servingPopulation(definitionAtSchema, evidenceRead),
      evidenceRead,
    );

    expect(reading).toMatchObject({ standing: 'short', missingTagKeys: ['owner_team'] });
  });
});

describe('the policy half, which applies where a classification says so', () => {
  const definition = defineServing(
    { named: [name('main', 'sales', 'orders')], policy: [{ classification: 'pii', requires: ['column-mask'] }] },
    1,
  );

  function read(over: Partial<ServingEvidence>) {
    const evidenceRead = evidence({ catalogued: [asset('main', 'sales', 'orders')], ...over });
    return policyReadings(definition, servingPopulation(definition, evidenceRead), evidenceRead)[0];
  }

  it('requires nothing of an asset no rule classifies', () => {
    const reading = read({ classifications: [{ on: name('main', 'sales', 'orders'), classification: 'public' }] });

    expect(reading).toMatchObject({ standing: 'not-required', required: [] });
  });

  it('requires nothing of an asset with no classification at all', () => {
    expect(read({})).toMatchObject({ standing: 'not-required' });
  });

  it('is met where the classified asset holds what its class requires', () => {
    const reading = read({
      classifications: [{ on: name('main', 'sales', 'orders'), classification: 'pii' }],
      protections: [{ on: name('main', 'sales', 'orders'), protection: 'column-mask' }],
    });

    expect(reading).toMatchObject({ standing: 'met', required: ['column-mask'], missing: [] });
  });

  it('is short where it does not, and says which protection', () => {
    const reading = read({
      classifications: [{ on: name('main', 'sales', 'orders'), classification: 'pii' }],
      protections: [{ on: name('main', 'sales', 'orders'), protection: 'row-filter' }],
    });

    expect(reading).toMatchObject({ standing: 'short', missing: ['column-mask'], held: ['row-filter'] });
  });

  it('is unmeasured where classification was not read, rather than not-required', () => {
    const reading = read({ classifications: null });

    expect(reading).toMatchObject({ standing: 'unmeasured', required: [] });
  });

  it('is unmeasured where the protections were not read, rather than short', () => {
    const reading = read({
      classifications: [{ on: name('main', 'sales', 'orders'), classification: 'pii' }],
      protections: null,
    });

    expect(reading).toMatchObject({ standing: 'unmeasured', required: ['column-mask'] });
  });

  it('requires nothing anywhere when the matrix is empty', () => {
    const undeclared = defineServing({ named: [name('main', 'sales', 'orders')] }, 1);
    const evidenceRead = evidence({
      catalogued: [asset('main', 'sales', 'orders')],
      classifications: [{ on: name('main', 'sales', 'orders'), classification: 'pii' }],
    });

    const [reading] = policyReadings(undeclared, servingPopulation(undeclared, evidenceRead), evidenceRead);

    expect(reading).toMatchObject({ standing: 'not-required', classifications: [] });
  });
});
