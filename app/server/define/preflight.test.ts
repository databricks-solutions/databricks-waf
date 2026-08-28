// Whether an assessment can run, before it is run.
//
// Two things here are worth more than the arithmetic. The grant text is asserted exactly, because
// the whole point of this module is that a reader can paste it — a nearly-right GRANT statement is a
// wrong instruction, and a wrong instruction teaches a metastore admin to ignore the next one. And
// the `unknown` reading is asserted to offer no remedy, which is the case a helpful-sounding
// implementation gets wrong: a 503 from a sleeping warehouse is not a missing grant.

import { describe, expect, it } from 'vitest';

import { define, type AssessmentDefinition } from './definition.js';
import {
  grantFor,
  includesPillar,
  preflight,
  probeStatement,
  readingFor,
  sourcesFor,
  tablesFor,
  type CheckSources,
  type Probe,
  type SignalSources,
} from './preflight.js';
import { loadCatalogue } from '../catalogue/catalogue.js';
import type { SignalId } from '../collect/signal.js';
import type { WorkspaceDirectory } from '../collect/sql/shapes.js';
import { signalDescriptors } from '../plan/descriptors.js';
import { buildRegistry } from '../resolve/resolvers/index.js';

const AT = new Date('2026-08-03T00:00:00Z');

function definition(): AssessmentDefinition {
  return define(
    { measurement: { scope: { kind: 'account' }, lookbackDays: 30 }, attribution: { name: 'Quarterly', owners: [] } },
    'def-1',
    AT,
    'alice@example.com',
  );
}

const SIGNALS: readonly SignalSources[] = [
  { id: 'sql:cost.attribution', tables: ['system.billing.usage'] },
  { id: 'sql:jobs.inventory', tables: ['system.lakeflow.jobs', 'system.billing.usage'] },
  { id: 'sql:uc.census', tables: ['system.information_schema.tables'] },
  { id: 'rest:clusters', tables: [] },
];

const CHECKS: readonly CheckSources[] = [
  { controlId: 'CO-01-01', pillarId: 'cost-optimisation', signals: ['sql:cost.attribution'] },
  { controlId: 'OE-01-01', pillarId: 'operational-excellence', signals: ['sql:jobs.inventory'] },
  { controlId: 'DG-01-01', pillarId: 'data-governance', signals: ['sql:uc.census'] },
  {
    // Two signals, both required, so a denial on either takes it.
    controlId: 'CO-02-01',
    pillarId: 'cost-optimisation',
    signals: ['sql:cost.attribution', 'sql:uc.census'],
  },
];

/** A probe that refuses the named tables with the platform's wording and allows the rest. */
function refusing(refusals: Readonly<Record<string, string>>): Probe {
  return (table) => {
    const message = refusals[table];
    return message != null ? Promise.reject(new Error(message)) : Promise.resolve();
  };
}

/** The warehouse's own wording for a missing grant, which is what `readingFor` classifies on. */
const DENIED = 'PERMISSION_DENIED: User does not have SELECT on Table `system.billing.usage`. SQLSTATE: 42501';

describe('preflight', () => {
  it('probes each table once, however many checks read it', async () => {
    const asked: string[] = [];
    await preflight(
      { definition: definition(), identity: 'alice@example.com', checks: CHECKS, signals: SIGNALS },
      (table) => {
        asked.push(table);
        return Promise.resolve();
      },
    );

    expect([...asked].sort()).toEqual([
      'system.billing.usage',
      'system.information_schema.tables',
      'system.lakeflow.jobs',
    ]);
    expect(new Set(asked).size, 'each table is probed once').toBe(asked.length);
  });

  it('reports every check ready when nothing is refused', async () => {
    const result = await preflight(
      { definition: definition(), identity: 'alice@example.com', checks: CHECKS, signals: SIGNALS },
      () => Promise.resolve(),
      AT,
    );

    expect(result.ready).toBe(4);
    expect(result.blocked).toEqual([]);
    expect(result.sources.every((source) => source.reading === 'readable')).toBe(true);
    expect(result.verdict).toContain('all 4');
  });

  it('names the exact grant for a refusal, at schema level and runnable', async () => {
    const result = await preflight(
      { definition: definition(), identity: 'alice@example.com', checks: CHECKS, signals: SIGNALS },
      refusing({ 'system.billing.usage': DENIED }),
      AT,
    );

    const usage = result.sources.find((source) => source.table === 'system.billing.usage');
    expect(usage?.reading).toBe('denied');
    expect(usage?.schema).toBe('system.billing');
    expect(usage?.grant).toBe('GRANT SELECT ON SCHEMA system.billing TO `alice@example.com`');
    expect(usage?.detail, 'the platform’s own words are carried through').toBe(DENIED);
  });

  /*
   * One denied table takes every check that reads it, including the one whose other signal answered.
   * A resolver needs all of `requires` to reach an outcome, so a check with a partly readable input
   * set reports unmeasurable rather than a partial verdict — and a preflight that counted it ready
   * would promise a result the run does not produce.
   */
  it('blocks every check that reads the denied table, not only the ones that read nothing else', async () => {
    const result = await preflight(
      { definition: definition(), identity: 'alice@example.com', checks: CHECKS, signals: SIGNALS },
      refusing({ 'system.billing.usage': DENIED }),
      AT,
    );

    expect(result.blocked.map((check) => check.controlId)).toEqual(['CO-01-01', 'CO-02-01', 'OE-01-01']);
    // Only DG-01-01, which reads the information schema alone.
    expect(result.ready).toBe(1);
    expect(result.blocked[0]?.needs).toEqual(['GRANT SELECT ON SCHEMA system.billing TO `alice@example.com`']);
  });

  it('lists the checks behind each source, so a grant can be costed before it is asked for', async () => {
    const result = await preflight(
      { definition: definition(), identity: 'alice@example.com', checks: CHECKS, signals: SIGNALS },
      refusing({ 'system.billing.usage': DENIED }),
      AT,
    );

    const usage = result.sources.find((source) => source.table === 'system.billing.usage');
    expect(usage?.blocks).toEqual(['CO-01-01', 'CO-02-01', 'OE-01-01']);
  });

  it('offers no grant for a table that is not there', async () => {
    const absent = 'TABLE_OR_VIEW_NOT_FOUND: The table or view `system.lakeflow.jobs` cannot be found.';
    const result = await preflight(
      { definition: definition(), identity: 'alice@example.com', checks: CHECKS, signals: SIGNALS },
      refusing({ 'system.lakeflow.jobs': absent }),
      AT,
    );

    const jobs = result.sources.find((source) => source.table === 'system.lakeflow.jobs');
    expect(jobs?.reading).toBe('absent');
    expect(jobs?.grant).toBeUndefined();
    expect(result.blocked.map((check) => check.controlId)).toEqual(['OE-01-01']);
    // A blocked check with no grant to ask for still has to appear, with an empty ask.
    expect(result.blocked[0]?.needs).toEqual([]);
    expect(result.verdict).toContain('not present on this metastore');
  });

  it('concludes nothing from a failure it does not recognise', async () => {
    const result = await preflight(
      { definition: definition(), identity: 'alice@example.com', checks: CHECKS, signals: SIGNALS },
      refusing({ 'system.billing.usage': 'The warehouse refused the request with 503: upstream unavailable' }),
      AT,
    );

    const usage = result.sources.find((source) => source.table === 'system.billing.usage');
    expect(usage?.reading).toBe('unknown');
    expect(usage?.grant).toBeUndefined();
    expect(result.verdict).toContain('does not recognise');
  });

  it('stamps the version it was run against', async () => {
    const subject = definition();
    const result = await preflight(
      { definition: subject, identity: 'alice@example.com', checks: CHECKS, signals: SIGNALS },
      () => Promise.resolve(),
      AT,
    );

    expect(result.definitionId).toBe('def-1');
    expect(result.version).toBe(1);
    expect(result.fingerprint).toBe(subject.versions[0]?.fingerprint);
    expect(result.ranAs).toBe('alice@example.com');
    expect(result.ranAt).toBe(AT);
  });

  it('resolves the scope when a directory was read, and says so when one was not', async () => {
    const prod = { workspaceId: '1', name: 'prod', status: 'RUNNING', live: true };
    const directory: WorkspaceDirectory = {
      workspaces: [prod],
      live: [prod],
      excluded: [],
      regionUnverified: [],
      outOfScope: [],
    };

    const withDirectory = await preflight(
      { definition: definition(), identity: 'alice@example.com', checks: CHECKS, signals: SIGNALS, directory },
      () => Promise.resolve(),
      AT,
    );
    expect(withDirectory.scope.assessed).toHaveLength(1);

    const without = await preflight(
      { definition: definition(), identity: 'alice@example.com', checks: CHECKS, signals: SIGNALS },
      () => Promise.resolve(),
      AT,
    );
    // Resolved either way. Without a directory the resolution holds the reason rather than an empty
    // estate, because empty sets would report every named workspace as absent and blame the estate for
    // what is either a permission error or a scan that has not run.
    expect(without.scope.assessed).toEqual([]);
    expect(without.scope.complete).toBe(false);
    expect(without.scope.undeterminedReason).toContain('No scan has read the account directory');
    expect(without.verdict).toContain('not known yet');

    // An unresolved scope is an unrun scan, not an unreadable table. The probe two lines above may
    // have just read the directory successfully, and a verdict claiming otherwise in the same
    // paragraph sends the reader to ask for a grant they already hold.
    expect(without.verdict).toContain('No scan has read the account directory');
    expect(without.verdict).not.toContain('could not be read');
  });

  it('leaves a space between its sentences', async () => {
    // Every clause here is assembled from parts, and the joins have been wrong in both directions:
    // one branch prefixing its own space and another not, giving `can run.The account directory`.
    // Any reader sees it immediately, no other assertion does.
    const each = await Promise.all(
      [
        () => Promise.resolve(),
        refusing({ 'system.billing.usage': DENIED }),
        refusing({ 'system.lakeflow.jobs': 'TABLE_OR_VIEW_NOT_FOUND: `system.lakeflow.jobs` cannot be found.' }),
        refusing({ 'system.billing.usage': 'The warehouse refused the request with 503: upstream unavailable' }),
      ].map((probe) =>
        preflight(
          { definition: definition(), identity: 'alice@example.com', checks: CHECKS, signals: SIGNALS },
          probe,
          AT,
        ),
      ),
    );

    for (const result of each) {
      // A capital straight after a full stop, which is how the sentences here begin. A lowercase one
      // would false-positive on `alice@example.com`.
      expect(result.verdict, 'a sentence begins hard against the previous one').not.toMatch(/\.\p{Lu}/u);
      expect(result.verdict, 'a clause was joined with two spaces').not.toMatch(/\s\s/u);
      expect(result.verdict.trim()).toBe(result.verdict);
      expect(result.verdict).toMatch(/\.$/u);
    }
  });

  it('says there is nothing to authorise when no check reads a system table', async () => {
    const result = await preflight(
      {
        definition: definition(),
        identity: 'alice@example.com',
        checks: [{ controlId: 'SCP-01-06', pillarId: 'security', signals: ['rest:clusters'] }],
        signals: SIGNALS,
      },
      () => expect.fail('nothing should be probed'),
      AT,
    );

    expect(result.sources).toEqual([]);
    expect(result.verdict).toContain('nothing to authorise');
  });
});

describe('readingFor', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['PERMISSION_DENIED: User does not have SELECT on Table', 'denied'],
    ['INSUFFICIENT_PERMISSIONS: requires SELECT privilege', 'denied'],
    ['403 Forbidden', 'denied'],
    ['TABLE_OR_VIEW_NOT_FOUND', 'absent'],
    ['[SCHEMA_NOT_FOUND] The schema `system.storage` cannot be found', 'absent'],
    ['Connection reset by peer', 'unknown'],
    /*
     * Both signals in one message, which Unity Catalog does emit: a table the caller may not see is
     * reported as not found so that the refusal does not leak what exists. Neither guess is safe from
     * here — one sends somebody to a metastore admin for a table that is not there, the other to an
     * account admin for a schema already enabled — so it concludes nothing.
     */
    [
      'PERMISSION_DENIED: User does not have USE SCHEMA on system.storage, or the table cannot be found.',
      'unknown',
    ],
  ];

  for (const [message, expected] of cases) {
    it(`reads "${message.slice(0, 40)}" as ${expected}`, () => {
      expect(readingFor(message)).toBe(expected);
    });
  }
});

describe('probeStatement', () => {
  it('reads no rows', () => {
    expect(probeStatement('system.billing.usage')).toBe('SELECT 1 FROM system.billing.usage WHERE false');
  });
});

describe('grantFor', () => {
  it('quotes the identity, since an email is not a bare identifier', () => {
    expect(grantFor('system.access', 'alice@example.com')).toBe(
      'GRANT SELECT ON SCHEMA system.access TO `alice@example.com`',
    );
  });

  /*
   * The identity arrives on a request header and this statement is one the app tells a metastore
   * admin to run in a privileged session. A backtick left as-is closes the identifier early and the
   * rest of the value becomes SQL. Doubling is how Databricks escapes one inside a quoted identifier,
   * so the whole value stays a single token.
   */
  it('keeps the identity a single token whatever it contains', () => {
    const grant = grantFor('system.access', 'a`; GRANT ALL PRIVILEGES ON CATALOG main TO `attacker');

    expect(grant).toBe(
      'GRANT SELECT ON SCHEMA system.access TO `a``; GRANT ALL PRIVILEGES ON CATALOG main TO ``attacker`',
    );
    // One statement, and every backtick inside the value doubled.
    expect(grant?.match(/GRANT/g)).toHaveLength(2);
    expect(grant?.slice('GRANT SELECT ON SCHEMA system.access TO '.length).match(/(?<!`)`(?!`)/g)).toHaveLength(2);
  });

  /*
   * No escape exists for a line break inside an identifier, and no platform issues a principal
   * containing one. A multi-line statement under a caption reading "runnable as written" is worse to
   * emit than nothing, so the denial is reported without a line to run.
   */
  it('declines rather than emitting a statement it cannot quote', () => {
    expect(grantFor('system.access', 'alice@example.com\nGRANT ALL')).toBeUndefined();
    expect(grantFor('system.access', '  ')).toBeUndefined();
  });
});

describe('tablesFor', () => {
  it('is the distinct tables the checks read, sorted', () => {
    expect(tablesFor(CHECKS, SIGNALS)).toEqual([
      'system.billing.usage',
      'system.information_schema.tables',
      'system.lakeflow.jobs',
    ]);
  });
});

describe('sourcesFor', () => {
  const catalogue = loadCatalogue();
  const registry = buildRegistry();
  const descriptors = signalDescriptors();

  it('includes only the pillars the definition names', () => {
    const all = sourcesFor({
      catalogue,
      registry,
      descriptors,
      measurement: { scope: { kind: 'account' }, lookbackDays: 30 },
    });
    const one = sourcesFor({
      catalogue,
      registry,
      descriptors,
      measurement: { scope: { kind: 'account' }, lookbackDays: 30, pillars: ['cost-optimization'] },
    });

    expect(one.checks.length, 'the pillar has checks').toBeGreaterThan(0);
    expect(one.checks.length, 'and fewer than every pillar has').toBeLessThan(all.checks.length);
    expect(one.checks.every((check) => check.pillarId === 'cost-optimization')).toBe(true);
  });

  it('carries the directory signal into every SQL check, since every statement filters on it', () => {
    const { checks, signals } = sourcesFor({
      catalogue,
      registry,
      descriptors,
      measurement: { scope: { kind: 'account' }, lookbackDays: 30 },
    });

    const directory = signals.find((signal) => signal.id === ('sql:estate.workspaces' as SignalId));
    expect(directory?.tables, 'the directory reads the account list').toContain('system.access.workspaces_latest');

    const sql = checks.filter((check) => check.signals.some((signal) => signal.startsWith('sql:')));
    expect(sql.length).toBeGreaterThan(0);
    const without = sql.filter((check) => !check.signals.includes('sql:estate.workspaces'));
    expect(without, 'no SQL check depends on its own statement alone').toEqual([]);
  });

  it('leaves prose out of the probe list, since a sentence is not a table', () => {
    const { signals } = sourcesFor({
      catalogue,
      registry,
      descriptors,
      measurement: { scope: { kind: 'account' }, lookbackDays: 30 },
    });

    for (const signal of signals) {
      for (const table of signal.tables) {
        expect(table, `${signal.id} probes ${table}`).toMatch(/^[a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+$/);
      }
    }
    // The per-object and REST signals read no system table, so they contribute nothing to probe.
    expect(signals.find((signal) => signal.id === ('describe:storage.table_details' as SignalId))?.tables).toEqual([]);
  });

  it('probes each table once across the whole catalogue', () => {
    const { checks, signals } = sourcesFor({
      catalogue,
      registry,
      descriptors,
      measurement: { scope: { kind: 'account' }, lookbackDays: 30 },
    });

    const tables = tablesFor(checks, signals);
    expect(new Set(tables).size).toBe(tables.length);
    // A bound rather than a range for its own sake: every table here is one statement on the
    // customer's warehouse when somebody presses the button, and the count is 28 today. A statement
    // that pushed it past 40 would make the preflight slower than the scan it is checking, which is
    // a decision somebody should make rather than one that arrives with a new query.
    expect(tables.length, 'more than a token probe').toBeGreaterThan(5);
    expect(tables.length, 'and not slower than the scan it checks').toBeLessThanOrEqual(40);
  });
});

describe('includesPillar', () => {
  it('covers everything when no pillars are named', () => {
    expect(includesPillar({ scope: { kind: 'account' }, lookbackDays: 30 }, 'security')).toBe(true);
  });

  it('covers only what is named when a list is given', () => {
    const measurement = { scope: { kind: 'account' } as const, lookbackDays: 30, pillars: ['security'] };
    expect(includesPillar(measurement, 'security')).toBe(true);
    expect(includesPillar(measurement, 'reliability')).toBe(false);
  });
});
