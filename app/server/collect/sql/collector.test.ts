// What the system-table collector is a statement about.
//
// This file exists because of a wrong answer that was live for weeks. Every statement was
// filtered to the host workspace, so a scan of an eleven-workspace account reported on one
// and told the user their account had been assessed. The bug was invisible: the numbers
// were internally consistent and the UI said "Assessed for workspace 7000000000000023",
// which reads as precision rather than as a tenth of the evidence.
//
// So the tests here are about the filter and the reach, not about parsing. A parsing bug
// shows up as a blank field somebody reports. A scoping bug shows up as a confident score.

import { describe, expect, it, vi } from 'vitest';
import { CollectionScheduler } from '../../scan/scheduler.js';
import { accountScope, selectedScope, workspaceScope } from '../estate-scope.js';
import type { CollectorContext, SignalId } from '../signal.js';
import { SqlCollector, SQL_QUERY_PARAMS, SQL_SIGNAL_SOURCES, SQL_SIGNALS, type SqlParameters } from './collector.js';
import type { QuerySource } from './queries.js';
import type { CredentialProvider } from '../credentials.js';
import type { WorkspaceDirectory } from './shapes.js';

/**
 * Every query resolves to trivial text naming itself, so a test can find the statement it
 * cares about by name. Indexing by position would silently retarget the moment the
 * collector changes what it runs first, which it now does.
 */
const queries: QuerySource = { text: (name) => `-- ${name}\nSELECT 1` };

function context(): CollectorContext {
  return { credentials: userCredentials(), scheduler: new CollectionScheduler(), collected: new Map() };
}

/**
 * A credential provider the collector never calls, because the executor is injected.
 *
 * Built properly rather than cast into place: a cast would also have accepted the wrong
 * shape, and the reason this seam exists is that the same collectors run as a user and as
 * a service principal. A fixture that does not satisfy the interface is a fixture that
 * stops noticing when the interface changes.
 */
function userCredentials(): CredentialProvider {
  return {
    mode: 'on-behalf-of-user',
    databricks: () =>
      Promise.resolve({
        mode: 'on-behalf-of-user',
        actor: 'a@example.com',
        host: 'https://example.cloud.databricks.com',
        token: () => Promise.resolve('token'),
      }),
    cloud: () => Promise.resolve(null),
  };
}

/**
 * Signal ids as a typed array.
 *
 * A bare array literal widens to `string[]`, which does not satisfy `SignalId[]` — hence
 * the double casts this replaces. Passing them as arguments gets them checked against
 * `SignalId` individually instead, so a typo in one is a compile error rather than a
 * signal the collector silently has no definition for.
 */
function signals(...ids: SignalId[]): SignalId[] {
  return ids;
}

interface Executed {
  readonly query: string;
  readonly parameters: SqlParameters;
}

function collectorWith(scope: ReturnType<typeof accountScope>, directoryRows?: readonly Record<string, unknown>[]) {
  const executed: Executed[] = [];
  const executor = vi.fn((statement: string, parameters: SqlParameters) => {
    const query = /^-- (\S+)/.exec(statement)?.[1] ?? statement;
    executed.push({ query, parameters });
    return Promise.resolve({ data: query === 'workspace_directory' ? (directoryRows ?? []) : [] });
  });
  return {
    collector: new SqlCollector({ executor, scope, queries }),
    executed,
    /** The parameters bound to a named query, or undefined if it never ran. */
    paramsFor: (query: string) => executed.find((statement) => statement.query === query)?.parameters,
  };
}

/** A directory row in the stringified shape the statement API returns. */
function workspaceRow(id: string, status: string, region?: string) {
  return {
    workspace_id: id,
    workspace_name: `ws-${id}`,
    workspace_url: `https://ws-${id}.cloud.databricks.com`,
    status,
    // Absent for a workspace billing only classic compute, whose SKU names carry no region.
    ...(region == null ? {} : { region }),
    live: status === 'RUNNING' ? 'true' : 'false',
    create_time: '2026-01-01T00:00:00.000Z',
  };
}

/** The bound value of a parameter, unwrapped from the SQL parameter envelope. */
function valueOf(parameters: SqlParameters, name: string): string | undefined {
  return parameters[name]?.value;
}

describe('by default', () => {
  it('binds no workspace filter, so the account is assessed rather than one workspace', async () => {
    const { collector, executed } = collectorWith(accountScope('7000000000000023'));

    await collector.collect(SQL_SIGNALS, context());

    // Every statement that takes the parameter must bind it empty. The queries read an
    // empty string as "no filter", so a single non-empty binding here silently narrows
    // that signal while its neighbours stay account-wide — the worst of both.
    const filters = executed
      .map((statement) => valueOf(statement.parameters, 'workspace_id'))
      .filter((value) => value != null);
    expect(filters.length).toBeGreaterThan(0);
    expect(filters.every((value) => value === '')).toBe(true);
  });

  it('still knows which workspace it is running in', () => {
    // Needed for the workspace-reach signals and to name the workspace in findings. The
    // point of the change is that knowing the workspace no longer means filtering to it.
    expect(accountScope('123').hostWorkspaceId).toBe('123');
    expect(accountScope('123').narrowedTo).toBeUndefined();
  });

  it('reports account reach only for the directory, and metastore reach for everything scoped to it', async () => {
    const { collector } = collectorWith(accountScope('123'));

    const results = await collector.collect(SQL_SIGNALS, context());
    const reachOf = (id: string) => results.find((result) => result.id === id)?.coverage.reach;

    // The directory alone. It reads `workspaces_latest`, which is global, and it reports every
    // workspace including the ones it marks as being in another region.
    expect(reachOf('sql:estate.workspaces')).toBe('account');

    // These read regional tables — `system.compute.clusters`, `system.compute.warehouses`,
    // `system.lakeflow.jobs`, `system.access.audit` — and said `account` until E1. The tables were
    // always regional, so the claim was always wrong; what changed is that the region filter made the
    // numbers move, which is how anyone noticed.
    expect(reachOf('sql:compute.warehouses')).toBe('metastore');
    expect(reachOf('sql:compute.clusters')).toBe('metastore');
    expect(reachOf('sql:jobs.inventory')).toBe('metastore');
    expect(reachOf('sql:governance.audit_coverage')).toBe('metastore');

    // And these read a global table, `system.billing.usage`, but are deliberately filtered to the same
    // live set so that cost and compute describe one estate rather than two of different sizes.
    expect(reachOf('sql:cost.compute_mix')).toBe('metastore');
    expect(reachOf('sql:estate.compute_profile')).toBe('metastore');

    // Metastore-wide for the original reason: information_schema belongs to the metastore attached to
    // this workspace, so claiming account reach here would overclaim on a multi-region account.
    expect(reachOf('sql:uc.census')).toBe('metastore');
    expect(reachOf('sql:uc.lineage_coverage')).toBe('metastore');
    expect(reachOf('sql:storage.sample_selection')).toBe('metastore');
  });

  it('declares no wider reach than its filter allows', () => {
    // The invariant behind the test above, so a statement added later cannot reintroduce the
    // over-claim by declaring `account` beside a filter that narrows it to one region. Derived from the
    // definitions rather than listed, because a list is the thing that goes stale.
    const overclaiming = Object.entries(SQL_SIGNAL_SOURCES)
      .filter(([, source]) => source.reach === 'account')
      .filter(([, source]) => (SQL_QUERY_PARAMS[source.query] ?? []).includes('live_workspace_ids'))
      .map(([id]) => id);

    expect(
      overclaiming,
      'A statement filtered to the live workspace ids covers one region, not the account. Declare ' +
        '`metastore`, or stop taking the filter.'
    ).toEqual([]);
  });

  it('states a reach on every signal it collects', async () => {
    const { collector } = collectorWith(accountScope('123'));

    const results = await collector.collect(SQL_SIGNALS, context());

    // An unstated reach is not a neutral default — downstream it renders as an unqualified
    // claim about the estate, which is the overclaim this whole change is about. Stated on
    // the unreadable signals too: reach is a property of the statement, so a signal that
    // failed still says what it would have been a statement about.
    expect(results).toHaveLength(SQL_SIGNALS.length);
    expect(results.every((result) => result.coverage.reach != null)).toBe(true);
  });
});

describe('a statement that returns more rows than its header declares', () => {
  // The half of the row-bound mechanism that runs against a real estate. The static check in
  // scripts/check-statement-bounds.mjs reads the files; this reads what came back, which is the only
  // side that can catch a declaration that was true when it was written and is not any more.
  //
  // Everything hangs on it warning rather than failing. Inline results are capped at 25 MiB and fail
  // past the cap, so this is a real risk — but by the time the count is known the rows are in hand
  // and parseable, and dropping a usable reading because a comment in a .sql file is stale would turn
  // a documentation error into a lost measurement. That trade is wrong in a tool whose entire claim is
  // that it says what it did and did not see.
  function overrunning() {
    const executor = vi.fn((statement: string) => {
      const query = /^-- (\S+)/.exec(statement)?.[1] ?? statement;
      const rows = query === 'workspace_directory' ? [workspaceRow('1', 'RUNNING'), workspaceRow('2', 'RUNNING')] : [];
      return Promise.resolve({ data: rows });
    });
    return new SqlCollector({
      executor,
      scope: accountScope('1'),
      // One row declared, two returned.
      queries: { text: (name) => `-- ${name}\n-- Rows: 1\nSELECT 1` },
    });
  }

  it('says which statement it was, what it declared, and why the difference matters', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await overrunning().collect(signals('sql:estate.workspaces'), context());

    const warnings = warn.mock.calls.map((call) => String(call[0]));
    const overrun = warnings.find((message) => message.includes('workspace_directory'));
    expect(overrun).toBeDefined();
    expect(overrun).toContain('2 rows');
    expect(overrun).toContain('declared ceiling of 1');
    // The consequence, not just the discrepancy. Two rows against one looks like a typo until you
    // know the statement fails outright rather than truncating.
    expect(overrun).toContain('25 MiB');
    warn.mockRestore();
  });

  it('keeps the measurement it warned about', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const [result] = await overrunning().collect(signals('sql:estate.workspaces'), context());

    expect(result?.status).toBe('observed');
    expect((result?.value as WorkspaceDirectory).live).toHaveLength(2);
    warn.mockRestore();
  });

  it('says nothing about a statement whose declaration holds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const collector = new SqlCollector({
      executor: vi.fn(() => Promise.resolve({ data: [workspaceRow('1', 'RUNNING')] })),
      scope: accountScope('1'),
      queries: { text: (name) => `-- ${name}\n-- Rows: 1\nSELECT 1` },
    });

    await collector.collect(signals('sql:estate.workspaces'), context());

    expect(warn.mock.calls.map((call) => String(call[0])).filter((message) => message.includes('rows'))).toEqual([]);
    warn.mockRestore();
  });

  describe('and a statement declaring a ceiling nothing binds', () => {
    // The case a reviewer found: `-- Rows: at most :made_up_limit` was enforced by nothing. The static
    // check matched the shape and stopped, the parameter test strips comment lines so the parameter was
    // invisible to it, and this layer treated an unbound cap as nothing to enforce. A declaration that
    // silently switches off the thing enforcing it is worse than no declaration, because the header
    // then reads to the next author as evidence the statement is capped.
    async function warnings() {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const collector = new SqlCollector({
        executor: vi.fn(() => Promise.resolve({ data: [workspaceRow('1', 'RUNNING'), workspaceRow('2', 'RUNNING')] })),
        scope: accountScope('1'),
        queries: { text: (name) => `-- ${name}\n-- Rows: at most :made_up_limit\nSELECT 1` },
      });

      await collector.collect(signals('sql:estate.workspaces'), context());
      const messages = warn.mock.calls.map((call) => String(call[0]));
      warn.mockRestore();
      return messages;
    }

    it('warns rather than falling silent', async () => {
      const unbound = (await warnings()).find((message) => message.includes('made_up_limit'));
      expect(unbound).toBeDefined();
      expect(unbound).toContain('workspace_directory');
      expect(unbound).toContain('checked against nothing');
    });
  });
});

describe('a statement that answers nothing', () => {
  // The stub executor returns no rows for everything, which is exactly the case: a query
  // matching nothing still returns a row of zeroes, and zeroes are indistinguishable from
  // a measurement by the time a resolver divides one by another.
  it('reports the storage snapshot unmeasurable rather than an estate of zero bytes', async () => {
    const { collector } = collectorWith(accountScope('123'));

    const results = await collector.collect(SQL_SIGNALS, context());
    const snapshot = results.find((result) => result.id === 'sql:storage.table_metrics');

    expect(snapshot?.status).toBe('unmeasurable');
    // The reason has to name the table, because the action it implies — wait for the
    // platform snapshot, or read the sampled per-table pass instead — is not guessable
    // from "unavailable".
    expect(snapshot?.unmeasurableReason).toContain('table_metrics_history');
    expect(snapshot?.value).toBeUndefined();
  });

  it('still reports a census over an empty metastore as a measurement', async () => {
    const { collector } = collectorWith(accountScope('123'));

    const results = await collector.collect(SQL_SIGNALS, context());

    // The distinction the `noAnswer` rule exists to draw. A metastore with no tables is a
    // real observation and the controls above it correctly leave the denominator; treating
    // it as unreadable would hide an empty estate behind a tooling complaint.
    expect(results.find((result) => result.id === 'sql:uc.census')?.status).toBe('observed');
  });
});

describe('the live-workspace filter', () => {
  // The account tables are slowly-changing histories, so a cancelled workspace keeps its
  // clusters, warehouses and jobs. Measured on labs: 68 undeleted warehouses of which 4
  // are real. Widening from one workspace to the account without this filter replaces one
  // wrong number with a bigger one.
  const DIRECTORY = [
    workspaceRow('1', 'RUNNING'),
    workspaceRow('2', 'RUNNING'),
    workspaceRow('3', 'BANNED'),
    workspaceRow('4', 'FAILED'),
    workspaceRow('5', 'PROVISIONING'),
  ];

  it('passes only the running workspaces to the statements that filter on it', async () => {
    const { collector, paramsFor } = collectorWith(accountScope('1'), DIRECTORY);

    await collector.collect(SQL_SIGNALS, context());

    // Banned, failed and still-provisioning workspaces are all excluded: none of them is
    // an estate whose configuration anyone can act on.
    expect(valueOf(paramsFor('compute_warehouse_inventory') ?? {}, 'live_workspace_ids')).toBe('1,2');
    expect(valueOf(paramsFor('jobs_inventory') ?? {}, 'live_workspace_ids')).toBe('1,2');
    expect(valueOf(paramsFor('cost_attribution_coverage') ?? {}, 'live_workspace_ids')).toBe('1,2');
  });

  it('excludes a running workspace in another region, which billing can see and no other table can', async () => {
    // The asymmetry that made this necessary: `system.billing.usage` and `workspaces_latest` are
    // documented as global, while the compute and jobs tables are regional. Measured on a large
    // account, 10 of 15 workspaces billed DBUs from outside the metastore's region — so the cost
    // signals saw 15 workspaces, every compute signal saw 5, and nothing reconciled the two.
    const { collector, paramsFor } = collectorWith(accountScope('1'), [
      workspaceRow('1', 'RUNNING', 'US_WEST_OREGON'),
      workspaceRow('2', 'RUNNING', 'US_WEST_OREGON'),
      workspaceRow('6', 'RUNNING', 'AP_TOKYO'),
      workspaceRow('7', 'RUNNING', 'EUROPE_IRELAND'),
    ]);

    await collector.collect(SQL_SIGNALS, context());

    // Including the cost statements, which read the global table and would otherwise report spend
    // for workspaces whose configuration this deployment cannot assess.
    expect(valueOf(paramsFor('compute_cluster_inventory') ?? {}, 'live_workspace_ids')).toBe('1,2');
    expect(valueOf(paramsFor('jobs_inventory') ?? {}, 'live_workspace_ids')).toBe('1,2');
    expect(valueOf(paramsFor('cost_attribution_coverage') ?? {}, 'live_workspace_ids')).toBe('1,2');
  });

  it('keeps a workspace whose region could not be read rather than dropping it on a guess', async () => {
    // A workspace running only classic compute bills SKUs with no region in the name. Excluding it
    // would silently shrink the estate on no evidence, where including it is a wrong answer the user
    // can see and the app can ask about.
    const { collector, paramsFor } = collectorWith(accountScope('1'), [
      workspaceRow('1', 'RUNNING', 'US_WEST_OREGON'),
      workspaceRow('2', 'RUNNING'),
      workspaceRow('6', 'RUNNING', 'AP_TOKYO'),
    ]);

    await collector.collect(SQL_SIGNALS, context());

    expect(valueOf(paramsFor('jobs_inventory') ?? {}, 'live_workspace_ids')).toBe('1,2');
  });

  it('filters on nothing when the host workspace\u2019s own region is unreadable', async () => {
    // No home region means no basis for comparison, so every running workspace stays in. The
    // alternative is picking a region from the data and assessing whichever workspaces happen to
    // match it, which would look like a scoped answer and be an arbitrary one.
    const { collector, paramsFor } = collectorWith(accountScope('1'), [
      workspaceRow('1', 'RUNNING'),
      workspaceRow('6', 'RUNNING', 'AP_TOKYO'),
      workspaceRow('7', 'RUNNING', 'EUROPE_IRELAND'),
    ]);

    await collector.collect(SQL_SIGNALS, context());

    expect(valueOf(paramsFor('jobs_inventory') ?? {}, 'live_workspace_ids')).toBe('1,6,7');
  });

  it('runs the directory before anything that depends on it, whatever order it was asked for', async () => {
    const { collector, executed } = collectorWith(accountScope('1'), DIRECTORY);

    // Deliberately asking for the dependent signal first. Relying on the caller's ordering
    // is how the per-table pass ended up with no sample to describe.
    await collector.collect(signals('sql:compute.warehouses', 'sql:estate.workspaces'), context());

    expect(executed[0]?.query).toBe('workspace_directory');
    expect(valueOf(paramsOf(executed, 'compute_warehouse_inventory'), 'live_workspace_ids')).toBe('1,2');
  });

  it('runs the directory once however many signals need it', async () => {
    const { collector, executed } = collectorWith(accountScope('1'), DIRECTORY);

    await collector.collect(SQL_SIGNALS, context());

    // It is charged to the same warehouse budget as every other statement, so collecting
    // it per dependent signal would cost seven statements to answer one question.
    expect(executed.filter((statement) => statement.query === 'workspace_directory')).toHaveLength(1);
  });

  it('declares the directory as an input so the scan plan reports it', () => {
    const { collector } = collectorWith(accountScope('1'), DIRECTORY);

    // No control reads the directory — it is a filter, not evidence — so the scan plan
    // drops it unless the dependency is declared. A live scan collected it correctly and
    // still omitted it from the signal list, which hides the one statement whose failure
    // silently widens every count.
    expect(collector.requires).toContain('sql:estate.workspaces');
  });

  it('reports the excluded workspaces rather than quietly dropping them', async () => {
    const { collector } = collectorWith(accountScope('1'), DIRECTORY);

    const [directory] = await collector.collect(signals('sql:estate.workspaces'), context());
    const value = directory.value as WorkspaceDirectory;

    // The count moving from 68 to 4 needs an explanation attached to it, or it reads as
    // the tool having lost most of the estate.
    expect(value.live.map((workspace) => workspace.workspaceId)).toEqual(['1', '2']);
    expect(value.excluded.map((workspace) => workspace.status)).toEqual(['BANNED', 'FAILED', 'PROVISIONING']);
    expect(value.workspaces).toHaveLength(5);
    // Names, so a finding can say ws-1 rather than printing an opaque id at the user.
    expect(value.live[0].name).toBe('ws-1');
  });

  it('widens rather than failing when the directory cannot be read', async () => {
    // workspaces_latest is in Public Preview and may be unreadable. Refusing to assess
    // anything would be a worse trade than assessing a wider set and saying so — but the
    // widening must be visible, which is what the empty binding signals downstream.
    const { collector, paramsFor } = collectorWith(accountScope('1'), []);

    await collector.collect(SQL_SIGNALS, context());

    expect(valueOf(paramsFor('compute_warehouse_inventory') ?? {}, 'live_workspace_ids')).toBe('');
  });
});

/*
 * A run started for an assessment that names its workspaces.
 *
 * The defect this closes was a pair of statements that were each internally consistent: the scope
 * resolution said "Assessed 3 of the 3 workspaces this assessment covers" and the statements had read the
 * whole account, because nothing carried the selection past the definition. So these assert what the
 * statements were bound to, not what the scope object holds.
 */
describe('a scope that names the workspaces to assess', () => {
  const DIRECTORY = [
    workspaceRow('1', 'RUNNING'),
    workspaceRow('2', 'RUNNING'),
    workspaceRow('3', 'RUNNING'),
    workspaceRow('9', 'BANNED'),
  ];

  it('binds only the named workspaces, so the statements read what the scope claims', async () => {
    const { collector, paramsFor } = collectorWith(selectedScope(accountScope('1'), ['1', '3']), DIRECTORY);

    await collector.collect(SQL_SIGNALS, context());

    expect(valueOf(paramsFor('compute_warehouse_inventory') ?? {}, 'live_workspace_ids')).toBe('1,3');
    expect(valueOf(paramsFor('cost_attribution_coverage') ?? {}, 'live_workspace_ids')).toBe('1,3');
  });

  it('keeps account reach, because a read of three workspaces is not a read of one', async () => {
    const { collector, executed } = collectorWith(selectedScope(accountScope('1'), ['1', '3']), DIRECTORY);

    const results = await collector.collect(SQL_SIGNALS, context());

    // `narrowedTo` would have forced every one of these to `workspace` and bound `workspace_id`, which
    // is the claim a single-workspace scan makes and not this one.
    expect(results.find((result) => result.id === 'sql:estate.workspaces')?.coverage.reach).toBe('account');
    const bound = executed
      .map((statement) => valueOf(statement.parameters, 'workspace_id'))
      .filter((value) => value != null);
    expect(bound.length).toBeGreaterThan(0);
    expect(bound.every((value) => value === '')).toBe(true);
  });


  it('reports the named workspaces as assessed and the rest as unasked rather than unassessable', async () => {
    const { collector } = collectorWith(selectedScope(accountScope('1'), ['1', '3']), DIRECTORY);

    const [directory] = await collector.collect(signals('sql:estate.workspaces'), context());
    const value = directory.value as WorkspaceDirectory;

    expect(value.live.map((one) => one.workspaceId)).toEqual(['1', '3']);
    expect(value.outOfScope.map((one) => one.workspaceId)).toEqual(['2']);
    expect(value.excluded.map((one) => one.workspaceId)).toEqual(['9']);
    // The three sets still sum to the account, which is what keeps the reported total checkable.
    expect(value.live.length + value.outOfScope.length + value.excluded.length).toBe(value.workspaces.length);
  });

  /*
   * The dangerous case, and the reason this is a refusal rather than a fallback. An empty filter reads as
   * no filter, so widening here would read every workspace in the account under a scope naming three —
   * charging the customer for the reading as well as telling them something false about it.
   */
  it('refuses the filtered statements rather than widening when the directory cannot be read', async () => {
    const ran: string[] = [];
    const executor = vi.fn((statement: string) => {
      const query = /^-- (\S+)/.exec(statement)?.[1] ?? statement;
      ran.push(query);
      // The directory table is in Public Preview and a real deployment is refused it. Unreadable, not
      // empty: an empty result is a directory that answered, and the two want different behaviour.
      if (query === 'workspace_directory') return Promise.reject(new Error('PERMISSION_DENIED'));
      return Promise.resolve({ data: [] });
    });
    const collector = new SqlCollector({ executor, scope: selectedScope(accountScope('1'), ['1', '3']), queries });

    const results = await collector.collect(SQL_SIGNALS, context());

    expect(ran).not.toContain('compute_warehouse_inventory');
    const refused = results.find((result) => result.id === 'sql:compute.warehouses');
    expect(refused?.status).toBe('unmeasurable');
    expect(refused?.unmeasurableReason).toContain('names the workspaces it covers');
  });

  it('refuses them when nothing named is assessable, naming the estate as where to look', async () => {
    const { collector, executed } = collectorWith(selectedScope(accountScope('1'), ['w-gone']), DIRECTORY);

    const results = await collector.collect(SQL_SIGNALS, context());

    expect(executed.some((statement) => statement.query === 'jobs_inventory')).toBe(false);
    expect(results.find((result) => result.id === 'sql:jobs.inventory')?.unmeasurableReason).toContain(
      'None of the 1 workspaces this assessment names is assessable'
    );
  });

  /*
   * The statements a selection cannot reach still run. Refusing them would leave a narrowed assessment
   * unable to measure the metastore it is attached to, and the estate note is where the limit is stated.
   */
  it('still reads the statements that cannot be held to a workspace set', async () => {
    const { collector, executed } = collectorWith(selectedScope(accountScope('1'), ['1']), DIRECTORY);

    await collector.collect(SQL_SIGNALS, context());

    expect(executed.some((statement) => statement.query === 'uc_asset_census')).toBe(true);
  });
});

function paramsOf(executed: readonly { query: string; parameters: SqlParameters }[], query: string): SqlParameters {
  return executed.find((statement) => statement.query === query)?.parameters ?? {};
}

describe('the per-schema census', () => {
  const SCHEMA_CENSUS = signals('sql:uc.schema_census');

  /** A census row for one schema, in the stringified shape the statement API returns. */
  function schemaRow(name: string, population: number) {
    return {
      table_catalog: 'main',
      table_schema: name,
      table_count: '10',
      managed_tables: '10',
      external_tables: '0',
      views: '0',
      metric_views: '0',
      foreign_tables: '0',
      optimized_format_tables: '10',
      described_tables: '4',
      distinct_owners: '1',
      schema_population: String(population),
    };
  }

  function collectorReturning(rows: readonly Record<string, unknown>[]) {
    const executor = vi.fn(() => Promise.resolve({ data: rows }));
    return new SqlCollector({ executor, scope: accountScope('1'), queries, segmentLimit: 2 });
  }

  it('binds the segment limit', async () => {
    const { collector, paramsFor } = collectorWith(accountScope('1'));

    await collector.collect(SCHEMA_CENSUS, context());

    expect(paramsFor('uc_schema_census')?.segment_limit?.value).toBe('500');
  });

  it('reports complete when every schema came back', async () => {
    const collector = collectorReturning([schemaRow('bronze', 2), schemaRow('silver', 2)]);

    const [result] = await collector.collect(SCHEMA_CENSUS, context());

    expect(result.coverage.mode).toBe('complete');
  });

  it('reports sampled with the population when the row cap cut the answer short', async () => {
    // The row count alone cannot tell these two cases apart — both return exactly the cap —
    // which is why the statement reports the population rather than the collector inferring
    // it. Claiming completeness here would let a resolver present the worst two schemas of
    // nine hundred as the worst in the estate.
    const collector = collectorReturning([schemaRow('bronze', 900), schemaRow('silver', 900)]);

    const [result] = await collector.collect(SCHEMA_CENSUS, context());

    expect(result.coverage.mode).toBe('sampled');
    expect(result.coverage.examined).toBe(2);
    expect(result.coverage.population).toBe(900);
    expect(result.coverage.basis).toContain('most tables first');
  });

  it('reports complete for an empty metastore rather than a sample of nothing', async () => {
    const collector = collectorReturning([]);

    const [result] = await collector.collect(SCHEMA_CENSUS, context());

    expect(result.coverage.mode).toBe('complete');
  });
});

describe('when the user asks to narrow to one workspace', () => {
  it('binds that workspace id as the filter', async () => {
    const { collector, paramsFor } = collectorWith(workspaceScope('999'));

    await collector.collect(signals('sql:cost.compute_mix'), context());

    expect(valueOf(paramsFor('cost_compute_mix') ?? {}, 'workspace_id')).toBe('999');
  });

  it('narrows the live-workspace filter too, rather than filtering twice by different rules', async () => {
    const { collector, paramsFor } = collectorWith(workspaceScope('999'), [workspaceRow('999', 'RUNNING')]);

    await collector.collect(signals('sql:cost.compute_mix'), context());

    // Both filters still apply, and they agree. The narrowed workspace must also be live,
    // or the user has asked about a workspace that no longer exists.
    expect(valueOf(paramsFor('cost_compute_mix') ?? {}, 'live_workspace_ids')).toBe('999');
  });

  it('reports workspace reach even for signals that could have seen the account', async () => {
    const { collector } = collectorWith(workspaceScope('999'));

    const [result] = await collector.collect(signals('sql:cost.compute_mix'), context());

    // The table is account-wide but the answer is not, because the filter narrowed it.
    // Reporting the table's reach here rather than the statement's would tell the user
    // their account was covered when they asked for one workspace.
    expect(result.coverage.reach).toBe('workspace');
  });
});

describe('an attempt carrying on a run that was interrupted', () => {
  // The statement is the expensive thing here. Every signal this collector produces is one query
  // against the customer's warehouse, so a resumed attempt that re-ran the ones an earlier attempt
  // had already read would charge the customer twice for the same rows — and the resumption would
  // save only the statement that was in flight when the app went away.
  const CENSUS = 'sql:uc.census' as SignalId;
  const MIX = 'sql:cost.compute_mix' as SignalId;
  const DIRECTORY = 'sql:estate.workspaces' as SignalId;

  function carrying(...ids: SignalId[]): CollectorContext {
    return {
      ...context(),
      collected: new Map(
        ids.map((id) => [
          id,
          { id, status: 'observed' as const, value: {}, coverage: { mode: 'complete' as const }, collectedAt: new Date(), durationMs: 1 },
        ])
      ),
    };
  }

  it('does not read a statement an earlier attempt already read', async () => {
    const { collector, executed } = collectorWith(accountScope('7000000000000023'));

    await collector.collect(signals(CENSUS, MIX), carrying(CENSUS));

    expect(executed.map((statement) => statement.query)).not.toContain('uc_asset_census');
    expect(executed.map((statement) => statement.query)).toContain('cost_compute_mix');
  });

  it('returns only what it read, so nothing is written to the record twice', async () => {
    const { collector } = collectorWith(accountScope('7000000000000023'));

    const results = await collector.collect(signals(CENSUS, MIX), carrying(CENSUS));

    // The reading the earlier attempt made is already on the record and already in the collection.
    // Returning it again would have the scan check-point it a second time for nothing.
    expect(results.map((result) => result.id)).toEqual([MIX]);
  });

  it('hands back a fresh workspace directory rather than the one it was carrying', async () => {
    // The one signal here that resumption cannot save anything on. The directory statement runs on
    // every attempt whether it was asked for or not, because parsing it is what sets the live workspace
    // ids the other statements filter on — and that state does not survive the attempt that read it.
    // Since it is paid for either way, the newer reading is the one to keep.
    const { collector, executed, paramsFor } = collectorWith(
      selectedScope(accountScope('7000000000000023'), ['999']),
      [workspaceRow('999', 'RUNNING')]
    );

    const results = await collector.collect(signals(DIRECTORY, MIX), carrying(DIRECTORY));

    expect(executed.map((statement) => statement.query)).toContain('workspace_directory');
    expect(results.map((result) => result.id)).toEqual([DIRECTORY, MIX]);
    // And the filter the other statements got came from that reading, which is the reason it has to be
    // re-read rather than assumed to still hold.
    expect(valueOf(paramsFor('cost_compute_mix') ?? {}, 'live_workspace_ids')).toBe('999');
  });

  it('reports each statement as it settles, so the next interruption costs one of them', async () => {
    const { collector } = collectorWith(accountScope('7000000000000023'));
    const settled: SignalId[] = [];

    const results = await collector.collect(signals(CENSUS, MIX), {
      ...context(),
      settled: (reading) => {
        settled.push(reading.id);
        return Promise.resolve();
      },
    });

    // Reported in the order they were read, and every one of them — reporting is about when a reading
    // becomes durable, so a collector that reported some and not others would leave a resumption that
    // re-reads an arbitrary subset.
    expect(settled).toEqual([CENSUS, MIX]);
    expect(results.map((result) => result.id)).toEqual([CENSUS, MIX]);
  });
});
