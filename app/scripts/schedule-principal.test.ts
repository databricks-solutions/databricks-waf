// Which grants a scheduled run's identity needs, and what a report of them says.
//
// The tool that uses these functions only ever runs against a real workspace, and the workspace it
// will usually run against is one somebody has already set up. So the case a real run exercises is
// the boring one — everything held, nothing to say — and the cases that matter are the ones that
// only appear on a fresh install or after a statement is added.
//
// The derivation is the part worth holding hardest. It exists because a hand-written list of grants
// drifts from the statements the app runs and nothing notices: an ungranted schema reads as an
// unmeasured requirement rather than as an error, which is the failure this whole file is against.

import { describe, expect, it } from 'vitest';
import { customerCatalogPredicate as fromTheApp } from '../server/collect/sql/queries.js';
import {
  CATALOG_PRIVILEGE,
  NOT_GRANTABLE,
  SCHEMA_PRIVILEGES,
  SHARING_PRIVILEGES,
  WITHHELD,
  catalogsAsked,
  customerCatalogPredicate,
  customerCatalogsQuery,
  grantableSchemas,
  lines,
  needsOf,
  partitionAvailableSchemas,
  reconcileSchemaAvailability,
  removalLines,
  schemaGrantsHeld,
  schemasRead,
  scimFilter,
  standing,
  statementsIn,
  withoutComments,
} from './schedule-principal.mjs';

const WHERE = {
  principal: '5af463d1-8cb9-4417-b2a5-725cea64cce5',
  group: 'admins',
  app: 'databricks-waf-assessment',
  warehouse: '0123456789abcdef',
};

const statement = (sql: string, name = 'one.sql') => [{ name, sql }];

describe('scimFilter', () => {
  it('quotes the value, because an unquoted one is a syntax error rather than a miss', () => {
    expect(scimFilter('applicationId', '5af463d1-8cb9-4417-b2a5-725cea64cce5')).toBe(
      'applicationId eq "5af463d1-8cb9-4417-b2a5-725cea64cce5"'
    );
  });

  it('survives a group name with a space in it, which is what most of them have', () => {
    // The case the whole helper is for. Unquoted, `displayName eq Well-Architected assessors` is not a
    // filter, and the tool reported that the group did not exist — which reads as a workspace that has
    // not been set up rather than as a tool that cannot ask the question.
    expect(scimFilter('displayName', 'Well-Architected assessors')).toBe('displayName eq "Well-Architected assessors"');
  });

  it('escapes a quote and a backslash, so a name containing one cannot end the literal early', () => {
    expect(scimFilter('displayName', 'the "data" team')).toBe('displayName eq "the \\"data\\" team"');
    expect(scimFilter('displayName', 'a\\b')).toBe('displayName eq "a\\\\b"');
  });
});

describe('schemasRead', () => {
  it('finds a schema a statement reads', () => {
    expect(schemasRead(statement('select 1 from system.billing.usage'))).toEqual(['billing']);
  });

  it('ignores a schema named only in a comment', () => {
    // Not hypothetical. `storage_sample_selection.sql` explains in a comment that it wanted
    // `system.storage.table_metrics_history` and could not use it, so a plain search asks for a
    // grant on a schema the app never reads — the same drift, pointing the other way.
    const sql = [
      '-- The plan was to rank by size, but `system.storage.table_metrics_history` is not usable here.',
      'select count(*) from system.information_schema.tables',
    ].join('\n');

    expect(schemasRead(statement(sql))).toEqual(['information_schema']);
  });

  it('ignores a schema named only inside a block comment', () => {
    expect(schemasRead(statement('/* system.storage was considered */ select 1 from system.query.history'))).toEqual([
      'query',
    ]);
  });

  it('reports one schema once, however many statements read it', () => {
    expect(
      schemasRead([
        { name: 'a.sql', sql: 'select 1 from system.billing.usage' },
        { name: 'b.sql', sql: 'select 1 from system.billing.list_prices' },
      ])
    ).toEqual(['billing']);
  });

  it('reads the whole tree, and finds the schemas the assessment actually uses', () => {
    // The one test here that is about this repository rather than about the function, and the one
    // that justifies the whole file. Written the first time this ran, it found `system.storage` —
    // read by `maintenance_recency.sql` and `storage_table_metrics.sql`, and absent from the list
    // `docs/scheduled-scans.md` had been telling operators to grant. Nothing had noticed, because
    // the symptom is a handful of requirements reporting themselves unmeasured.
    //
    // `data_classification` and `data_quality_monitoring` arrived with the serving-readiness read in
    // `45c`, and they are the first two schemas here that no scan reads: the five statements over them
    // run only when somebody has declared what they serve. The grant is still needed — an operator who
    // grants what a scan reads and nothing else gets a readiness page that reports two of its eight
    // dimensions unmeasured — so they belong in the list this derives rather than in a footnote.
    //
    // That "two" was six until row 65, and this comment asserted it anyway. The two schemas fed two
    // dimensions but sat in a statement carrying eight, and a refusal on one CTE fails a statement
    // rather than emptying a column, so what an ungranted operator actually got was six unmeasured.
    // ADR 0088 split them out, which made the sentence true; `readiness-read.test.ts` now asserts the
    // number against the dimensions rather than leaving it written here.
    //
    // `mlflow` and `serving` arrived with row 37g, which turned three model-lifecycle attestations into
    // readings. Unlike the two above them these are read by the scan itself, so an operator who does not
    // grant them gets three requirements reporting unmeasured rather than a readiness page missing rows.
    expect(schemasRead(statementsIn())).toEqual([
      'access',
      'billing',
      'compute',
      'data_classification',
      'data_quality_monitoring',
      'information_schema',
      'lakeflow',
      'mlflow',
      'query',
      'serving',
      'storage',
    ]);
  });
});

describe('withoutComments', () => {
  it('leaves the SQL alone when there are none', () => {
    expect(withoutComments('select 1').trim()).toBe('select 1');
  });

  it('takes a trailing comment off a line and keeps the line', () => {
    expect(withoutComments('select 1 -- why').trim()).toBe('select 1');
  });
});

describe('grantableSchemas', () => {
  it('keeps information_schema out of what it asks for', () => {
    // Measured on a real workspace: the grant is accepted and changes nothing, because the views
    // are filtered by what the reader may see. Asking for it would make the report say held while
    // the estate stayed half-visible, which is worse than not asking.
    const { grantable, ungrantable } = grantableSchemas(['billing', 'information_schema']);

    expect(grantable).toEqual(['billing']);
    expect(ungrantable).toEqual(['information_schema']);
  });

  it('names a reason for every schema it will not ask for', () => {
    for (const [schema, why] of Object.entries(NOT_GRANTABLE)) {
      expect(why, `${schema} is excluded without saying why`).toMatch(/\S/);
    }
  });
});

describe('workspace schema availability', () => {
  const optional = ['data_classification', 'data_quality_monitoring'];

  it('keeps both optional schemas actionable when the workspace offers both', () => {
    const reading = partitionAvailableSchemas(['billing', ...optional], ['billing', ...optional]);

    expect(reading).toEqual({ present: ['billing', ...optional], unavailable: [] });
    expect(needsOf({ ...WHERE, schemas: reading.present }).map((need) => need.id)).toContain(
      'schema:data_classification'
    );
    expect(needsOf({ ...WHERE, schemas: reading.present }).map((need) => need.id)).toContain(
      'schema:data_quality_monitoring'
    );
  });

  it('reports neither optional schema as a grant when the workspace offers neither', () => {
    const reading = partitionAvailableSchemas(['billing', ...optional], ['billing']);
    const needs = needsOf({ ...WHERE, schemas: reading.present });

    expect(reading).toEqual({ present: ['billing'], unavailable: optional });
    expect(needs.map((need) => need.id)).toContain('schema:billing');
    expect(needs.some((need) => optional.some((schema) => need.id === `schema:${schema}`))).toBe(false);
  });

  it('moves a schema that disappears during SHOW GRANTS back to platform availability', () => {
    const discovered = partitionAvailableSchemas(
      ['billing', 'data_classification'],
      ['billing', 'data_classification']
    );
    const reading = schemaGrantsHeld(discovered.present, (schema) => {
      if (schema === 'data_classification') {
        throw new Error('[SCHEMA_DOES_NOT_EXIST] The schema system.data_classification cannot be found.');
      }
      return ['USE SCHEMA', 'SELECT'];
    });
    const reconciled = reconcileSchemaAvailability(discovered, reading);
    const needs = needsOf({ ...WHERE, schemas: reconciled.present });

    expect(reading).toEqual({ held: { 'schema:billing': true }, unavailable: ['data_classification'] });
    expect(reconciled).toEqual({ present: ['billing'], unavailable: ['data_classification'] });
    expect(needs.some((need) => need.id === 'schema:data_classification')).toBe(false);
    expect(needs.some((need) => need.statement?.includes('system.data_classification'))).toBe(false);
  });

  it('does not hide a grant-read error that is not schema availability', () => {
    expect(() =>
      schemaGrantsHeld(['billing'], () => {
        throw new Error('PERMISSION_DENIED');
      })
    ).toThrow(/PERMISSION_DENIED/);
  });
});

describe('the customer catalogs', () => {
  it('excludes what the assessment excludes, to the character', () => {
    // The copy in the script and the definition in `server/collect/sql/queries.ts` are the same
    // sentence written twice, because the script runs under plain Node and cannot import a `.ts`.
    // A tool granting on a set derived differently from the set the assessment reads would grant on
    // the wrong catalogs and report success, so the two are compared rather than trusted.
    expect(customerCatalogPredicate('catalog_name')).toBe(fromTheApp('catalog_name'));
    expect(customerCatalogsQuery()).toContain(fromTheApp('catalog_name'));
  });

  it("asks for none unless told to, because visibility is the customer's decision", () => {
    // ADR 0063 made this the customer's call. The point of the flag is to make the decision one
    // command away, not to make it for them, so a plain `--apply` must not grant catalog visibility.
    expect(catalogsAsked(['--apply'], ['main', 'quest_e2e'])).toEqual([]);
  });

  it('takes all of the derived set, or the named part of it', () => {
    expect(catalogsAsked(['--catalogs', 'all'], ['main', 'quest_e2e'])).toEqual(['main', 'quest_e2e']);
    expect(catalogsAsked(['--catalogs', 'main, quest_e2e'], ['main', 'quest_e2e'])).toEqual(['main', 'quest_e2e']);
  });

  it('refuses a catalog outside the derived set rather than granting on it', () => {
    // A typo, or `system`. Granting BROWSE on a Databricks-owned catalog is not dangerous, and it is
    // also not something the assessment reads — so it would be a grant nobody could account for.
    expect(() => catalogsAsked(['--catalogs', 'systm'], ['main'])).toThrow(/Not a customer catalog/);
    expect(() => catalogsAsked(['--catalogs', 'system'], ['main'])).toThrow(/system/);
  });

  it('refuses --catalogs with nothing after it, rather than reading the next flag as a name', () => {
    expect(() => catalogsAsked(['--catalogs', '--apply'], ['main'])).toThrow(/needs a value/);
    expect(() => catalogsAsked(['--catalogs'], ['main'])).toThrow(/needs a value/);
  });

  it('reads the joined spelling too, rather than granting nothing and saying nothing', () => {
    // `--catalogs=all` is how half of everyone writes it, and reading only the spaced form made it a
    // silent no-op: the run reports the principal as fully granted, and the estate stays invisible.
    // Every other malformed input here throws, so silence was the inconsistency rather than the rule.
    expect(catalogsAsked(['--catalogs=all'], ['main', 'quest_e2e'])).toEqual(['main', 'quest_e2e']);
    expect(catalogsAsked(['--catalogs=main'], ['main', 'quest_e2e'])).toEqual(['main']);
    expect(() => catalogsAsked(['--catalogs='], ['main'])).toThrow(/needs a value/);
  });
});

describe('needsOf', () => {
  const needs = needsOf({ ...WHERE, schemas: ['billing', 'information_schema'] });

  it('puts group membership first, because that is where a broken setup stops', () => {
    // The order is the order the failures arrive in. Without the group the run is refused at the
    // door and none of the grants below has been consulted, so a report that led with a missing
    // schema grant would send the reader to the wrong place.
    expect(needs[0]?.id).toBe('group');
    expect(needs.map((need) => need.id)).toEqual(['group', 'app', 'warehouse', 'catalog', 'schema:billing']);
  });

  it('asks for use and select together, since select alone is refused', () => {
    const schema = needs.find((need) => need.id === 'schema:billing');

    expect(schema?.statement).toBe(
      'GRANT USE SCHEMA, SELECT ON SCHEMA system.billing TO `5af463d1-8cb9-4417-b2a5-725cea64cce5`'
    );
    expect(SCHEMA_PRIVILEGES).toEqual(['USE SCHEMA', 'SELECT']);
  });

  it('quotes the principal, so an application id is not read as an identifier', () => {
    for (const need of needs.filter((one) => one.kind === 'grant')) {
      expect(need.statement).toContain('`5af463d1-8cb9-4417-b2a5-725cea64cce5`');
    }
  });

  it('says why each one is needed, not only what it is', () => {
    for (const need of needs) expect(need.why, need.id).toMatch(/\S/);
  });

  it('asks for nothing on the store, which is the guess that costs an afternoon', () => {
    const asked = needs.map((need) => `${need.what} ${need.statement ?? ''}`).join(' ');

    expect(asked.toLowerCase()).not.toContain('postgres');
    expect(asked.toLowerCase()).not.toContain('lakebase');
  });

  it('asks for no catalog at all unless one was named', () => {
    expect(needs.some((need) => need.id.startsWith('catalog:'))).toBe(false);
  });

  it('asks for BROWSE on a named catalog, and not for anything that reads a row', () => {
    // Measured in `docs/plan/e1-populations.md` under E1d: BROWSE alone took a scheduled scan from
    // 25 answered requirements to 43. SELECT would take it to 49 and would also let an unattended
    // identity read the customer's data, which is the trade the guide puts in front of the operator.
    const withCatalog = needsOf({ ...WHERE, schemas: [], catalogs: ['main'] });
    const catalog = withCatalog.find((need) => need.id === 'catalog:main');

    expect(CATALOG_PRIVILEGE).toBe('BROWSE');
    expect(catalog?.statement).toBe('GRANT BROWSE ON CATALOG `main` TO `5af463d1-8cb9-4417-b2a5-725cea64cce5`');
    expect(catalog?.statement).not.toContain('SELECT');
    expect(catalog?.statement).not.toContain('USE CATALOG');
  });

  it('quotes a catalog name too, since a metastore will accept most of them', () => {
    const odd = needsOf({ ...WHERE, schemas: [], catalogs: ['a`b'] });

    expect(odd.find((need) => need.id === 'catalog:a`b')?.statement).toContain('CATALOG `a``b`');
  });

  it('carries an undo beside every grant it issues', () => {
    // The defect this row exists against, in the other direction: "Turning it off" told an operator
    // to revoke the grants and listed none of them, which is the same drift ADR 0063 was written
    // about. A grant with no recorded undo is one somebody has to reconstruct by hand.
    const all = needsOf({ ...WHERE, schemas: ['billing'], catalogs: ['main'] });

    for (const need of all.filter((one) => one.kind === 'grant')) {
      expect(need.undo, need.id).toContain('REVOKE');
      expect(need.undo, need.id).toContain('FROM `5af463d1-8cb9-4417-b2a5-725cea64cce5`');
    }
  });
});

describe('lines', () => {
  const settled = () => standing(needsOf({ ...WHERE, schemas: ['billing'] }), (need) => need.id !== 'schema:billing');

  it('says an install is ready when it is', () => {
    const report = lines({
      principal: WHERE.principal,
      profile: 'labs',
      settled: standing(needsOf({ ...WHERE, schemas: ['billing'] }), () => true),
      applied: [],
      ungrantable: [],
    }).join('\n');

    expect(report).toContain('holds everything a scheduled run needs');
    expect(report).not.toContain('MISSING');
  });

  it('marks what is missing, and refuses to call a partial run an assessment', () => {
    const report = lines({
      principal: WHERE.principal,
      profile: 'labs',
      settled: settled(),
      applied: [],
      ungrantable: [],
    }).join('\n');

    expect(report).toContain('MISSING  USE SCHEMA and SELECT on system.billing');
    expect(report).toContain('1 of 5 missing');
    expect(report).toContain('honest and not an assessment');
  });

  it('reports what it just granted as granted rather than as missing', () => {
    const report = lines({
      principal: WHERE.principal,
      profile: 'labs',
      settled: settled(),
      applied: ['schema:billing'],
      ungrantable: [],
    }).join('\n');

    expect(report).toContain('granted  USE SCHEMA and SELECT on system.billing');
    expect(report).toContain('Granted 1 of 5');
    expect(report).not.toContain('MISSING');
  });

  it('names the schema it did not ask for, so the omission is visible rather than silent', () => {
    const report = lines({
      principal: WHERE.principal,
      profile: 'labs',
      settled: standing(needsOf({ ...WHERE, schemas: ['billing'] }), () => true),
      applied: [],
      ungrantable: ['information_schema'],
    }).join('\n');

    expect(report).toContain('Not asked for: system.information_schema');
    expect(report).toContain('filtered by what the reader may see');
  });

  it('names platform-unavailable schemas without offering --apply as their remedy', () => {
    const report = lines({
      principal: WHERE.principal,
      profile: 'labs',
      settled: standing(needsOf({ ...WHERE, schemas: ['billing'] }), () => true),
      applied: [],
      ungrantable: [],
      unavailable: ['data_classification', 'data_quality_monitoring'],
    }).join('\n');

    expect(report).toContain('Platform-unavailable: system.data_classification');
    expect(report).toContain('Platform-unavailable: system.data_quality_monitoring');
    expect(report).toContain('--apply cannot create it');
    expect(report).not.toContain('MISSING  USE SCHEMA and SELECT on system.data_classification');
  });

  it('names the catalogs it did not ask for, so the option is visible on a run that skipped it', () => {
    // An opt-in nobody is told about produces the default by accident rather than by decision, and
    // the default here is the estate reading as empty — which is the whole of E1d.
    const report = lines({
      principal: WHERE.principal,
      profile: 'labs',
      settled: standing(needsOf({ ...WHERE, schemas: [] }), () => true),
      applied: [],
      ungrantable: [],
      catalogs: ['main', 'quest_e2e'],
    }).join('\n');

    expect(report).toContain('Not asked for: BROWSE on 2 customer catalogs — main, quest_e2e');
    expect(report).toContain('--catalogs all');
  });

  it('says nothing about catalogs on a run that asked for them', () => {
    const report = lines({
      principal: WHERE.principal,
      profile: 'labs',
      settled: standing(needsOf({ ...WHERE, schemas: [], catalogs: ['main'] }), () => true),
      applied: [],
      ungrantable: [],
      catalogs: ['main'],
    }).join('\n');

    expect(report).toContain('BROWSE on catalog main');
    expect(report).not.toContain('Not asked for: BROWSE');
  });

  it('names the sharing grants it did not ask for, and what a run without them counts', () => {
    // The same opt-in-nobody-hears-about failure as the catalogs above, on the four grants E1f
    // measured. A run that never learns of them reads an estate with a provider and a connection
    // as one with neither.
    const report = lines({
      principal: WHERE.principal,
      profile: 'labs',
      settled: standing(needsOf({ ...WHERE, schemas: [] }), () => true),
      applied: [],
      ungrantable: [],
    }).join('\n');

    expect(report).toContain('USE SHARE, USE RECIPIENT, USE PROVIDER, USE CONNECTION');
    expect(report).toContain('--sharing');
    expect(report).toContain('0 providers of 1');
  });

  it('says nothing about them on a run that asked, and issues one statement per privilege', () => {
    const needs = needsOf({ ...WHERE, schemas: [], sharing: true });
    const report = lines({
      principal: WHERE.principal,
      profile: 'labs',
      settled: standing(needs, () => true),
      applied: [],
      ungrantable: [],
    }).join('\n');

    expect(report).toContain('USE CONNECTION on the metastore');
    expect(report).not.toContain('--sharing');
    // Metastore-level, because three of the four cannot be granted per object at all — measured,
    // and the reason the flag takes no list of shares or connections to scope itself to.
    const statements = needs.filter((need) => need.id.startsWith('sharing:')).map((need) => need.statement);
    expect(statements).toEqual([
      `GRANT USE SHARE ON METASTORE TO \`${WHERE.principal}\``,
      `GRANT USE RECIPIENT ON METASTORE TO \`${WHERE.principal}\``,
      `GRANT USE PROVIDER ON METASTORE TO \`${WHERE.principal}\``,
      `GRANT USE CONNECTION ON METASTORE TO \`${WHERE.principal}\``,
    ]);
  });

  it('can take each sharing grant back, since a teardown that leaves them is not one', () => {
    const undos = needsOf({ ...WHERE, schemas: [], sharing: true })
      .filter((need) => need.id.startsWith('sharing:'))
      .map((need) => need.undo);

    expect(undos).toEqual(
      SHARING_PRIVILEGES.map(({ privilege }) => `REVOKE ${privilege} ON METASTORE FROM \`${WHERE.principal}\``)
    );
  });

  it('states what it deliberately withheld, since least privilege is a comparison', () => {
    const report = lines({
      principal: WHERE.principal,
      profile: 'labs',
      settled: standing(needsOf({ ...WHERE, schemas: [] }), () => true),
      applied: [],
      ungrantable: [],
    }).join('\n');

    expect(report).toContain('Deliberately not granted:');
    expect(WITHHELD.length).toBeGreaterThan(0);
    for (const one of WITHHELD) expect(report).toContain(one);
  });

  it('withholds SELECT on data catalogs rather than reading access to them', () => {
    // BROWSE is offered now, so the entry claiming data-catalog access is withheld had become
    // false in the direction that matters: a reader checking least privilege against this list
    // would not learn that estate visibility is available and off.
    const said = WITHHELD.join(' ');

    expect(said).toContain('SELECT on data catalogs');
    expect(said).toContain('--catalogs');
  });

  it('says what the flag asks for rather than whether this run asked for it', () => {
    // The list is static and the report prints it under every run, so a clause about the flag's
    // default reads as a claim about this run's state. It said BROWSE was "still off unless asked
    // for" five lines under `granted BROWSE on catalog main`, on a labs run that had just granted
    // it — a sentence the report contradicted itself.
    const report = lines({
      principal: WHERE.principal,
      profile: 'labs',
      settled: standing(needsOf({ ...WHERE, schemas: [], catalogs: ['main'] }), () => true),
      applied: ['BROWSE on catalog main'],
      ungrantable: [],
      catalogs: ['main'],
    }).join('\n');

    expect(report).toContain('BROWSE on catalog main');
    expect(report).not.toMatch(/BROWSE[^.]*\b(is|stays|remains|still)\b[^.]*\boff\b/i);
    expect(report).not.toMatch(/BROWSE[^.]*\bnot granted\b/i);
  });
});

describe('removalLines', () => {
  const everything = () => standing(needsOf({ ...WHERE, schemas: ['billing'], catalogs: ['main'] }), () => true);

  it('reports what it would remove and changes nothing until told', () => {
    const report = removalLines({
      principal: WHERE.principal,
      profile: 'labs',
      settled: everything(),
      removed: [],
    }).join('\n');

    expect(report).toContain('Would revoke:');
    expect(report).toContain('BROWSE on catalog main');
    expect(report).toContain('USE SCHEMA and SELECT on system.billing');
    expect(report).toContain('Nothing has changed yet. Add --apply');
  });

  it('says it cannot tell its own grant from an identical one made by hand', () => {
    // The one claim a teardown has to make honestly. `REVOKE` removes the privilege, not the record
    // of who granted it, so an operator who granted BROWSE themselves before this tool existed loses
    // it here — which they are entitled to know before running it rather than after.
    const report = removalLines({
      principal: WHERE.principal,
      profile: 'labs',
      settled: everything(),
      removed: [],
    }).join('\n');

    expect(report).toContain('cannot tell a grant');
    expect(report).toContain('made by hand');
  });

  it('leaves the two object permissions alone, and says why', () => {
    const report = removalLines({
      principal: WHERE.principal,
      profile: 'labs',
      settled: everything(),
      removed: [],
    }).join('\n');

    expect(report).toContain('CAN_USE on the app databricks-waf-assessment');
    expect(report).toContain('replaces an access list rather than editing it');
  });

  it('reports nothing to do where the principal holds nothing', () => {
    const report = removalLines({
      principal: WHERE.principal,
      profile: 'labs',
      settled: standing(needsOf({ ...WHERE, schemas: ['billing'] }), () => false),
      removed: [],
    }).join('\n');

    expect(report).toContain('Nothing to revoke');
    expect(report).not.toContain('Would revoke');
  });

  it('does not say the principal holds nothing while listing what it holds', () => {
    // The second `--revoke --apply`, which is a normal thing to run. Everything revocable is gone and
    // the two object permissions are not, so "the principal holds nothing this tool issues" printed
    // four lines above the list of what it found.
    const kept = standing(needsOf({ ...WHERE, schemas: [] }), (need) => need.id === 'app');
    const report = removalLines({ principal: WHERE.principal, profile: 'labs', settled: kept, removed: [] }).join('\n');

    expect(report).toContain('Left in place');
    expect(report).not.toContain('holds nothing');
    expect(report).toContain('Nothing this tool can revoke');
  });

  it('reads as done once it has run', () => {
    const settled = everything();
    const report = removalLines({
      principal: WHERE.principal,
      profile: 'labs',
      settled,
      removed: settled.filter((need) => need.kind === 'grant' || need.kind === 'membership').map((need) => need.id),
    }).join('\n');

    expect(report).toContain('Revoked:');
    expect(report).not.toContain('to go');
    expect(report).not.toContain('Add --apply');
  });
});
