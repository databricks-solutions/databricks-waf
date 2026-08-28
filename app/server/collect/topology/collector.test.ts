import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { TOPOLOGY_COLLECTOR_CAP, TOPOLOGY_DECLINED, TOPOLOGY_RELATIONS } from '../../../shared/api/topology.js';
import { declaredBound } from '../sql/bounds.js';
import type { SqlExecutor } from '../sql/collector.js';
import { grainProblem } from '../sql/grain.js';
import {
  COMPUTE_SIDE,
  COMPUTE_SIDE_RELATIONS,
  COMPUTE_SIDE_SKIPPED,
  DRAWN,
  TABLE_SIDE_RELATIONS,
  computeSideTopology,
  collectTopologyNames,
  tableSideQueries,
  tableSideTopology,
  topologyQueryDirectory,
} from './collector.js';
import { TOPOLOGY_NAMES_QUERY } from './names.js';

const GRAINED = ['system.lakeflow.jobs', 'system.compute.clusters'];

function files(): readonly { readonly name: string; readonly sql: string }[] {
  const directory = topologyQueryDirectory();
  return readdirSync(directory)
    .filter((name) => name.endsWith('.sql') && name !== `${TOPOLOGY_NAMES_QUERY}.sql`)
    .map((name) => ({ name: name.replace(/\.sql$/, ''), sql: readFileSync(join(directory, name), 'utf8') }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function body(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

describe('the table-side topology statements', () => {
  it('are the four drawn relations that terminate in a table', () => {
    expect([...TABLE_SIDE_RELATIONS]).toEqual(TOPOLOGY_RELATIONS.filter((relation) => relation.endsWith('-to-table')));
  });

  it('has a shipped file for every drawn relation, and no file that no relation uses', () => {
    expect(files().map((file) => file.name)).toEqual(
      [...TABLE_SIDE_RELATIONS, ...COMPUTE_SIDE_RELATIONS].map((relation) => DRAWN[relation].query).sort()
    );
  });

  it('declares at most :topology_limit and holds itself to it', () => {
    for (const file of files()) {
      expect(declaredBound(file.sql), file.name).toEqual({ kind: 'parameterised', parameter: 'topology_limit' });
      expect(body(file.sql), file.name).toMatch(/LIMIT\s+:topology_limit\s*$/);
    }
  });

  it('binds exactly the parameters the text uses', () => {
    const queries = tableSideQueries();
    for (const file of files()) {
      const used = [...new Set(body(queries.text(file.name)).match(/:([a-z_]+)/g) ?? [])]
        .map((match) => match.slice(1))
        .sort();
      expect(used, file.name).toEqual(['lookback_days', 'topology_limit', 'workspace_id']);
    }
  });

  it('does not read a change-log table the grain check would have to qualify', () => {
    for (const file of files()) {
      for (const table of GRAINED) {
        expect(file.sql, `${file.name} reads ${table}`).not.toContain(table);
      }
    }
  });

  it('guards every period table it does read', () => {
    for (const file of files()) {
      expect(grainProblem(file.sql), file.name).toBeUndefined();
    }
  });

  it('keeps both ends named in the statement, not only in the parser', () => {
    for (const file of files()) {
      const sql = body(file.sql);
      expect(sql, file.name).toMatch(/IS NOT NULL/);
      expect(sql, file.name).toMatch(/GROUP BY/i);
    }
  });

  it('opts the table-side statements into the customer-catalog fragment', () => {
    // Same population the assessment uses. Spelling the predicate here would be
    // a second copy of the sentence row 80 already found wrong once. The four
    // that terminate in a table have to opt in; the three that do not have no
    // catalog to test. Easy to forget — 101c shipped without it, and labs then
    // drew every `samples` catalog the workspace ships with.
    const tableSide = new Set(TABLE_SIDE_RELATIONS.map((relation) => DRAWN[relation].query));
    for (const file of files()) {
      if (tableSide.has(file.name)) {
        expect(body(file.sql), file.name).toContain('{{customer_catalog');
        expect(body(file.sql), file.name).not.toContain('catalog_owner');
      } else {
        expect(body(file.sql), file.name).not.toContain('{{customer_catalog');
      }
    }
  });

  it('expands that fragment to the same predicate the assessment ships', () => {
    const queries = tableSideQueries();
    for (const relation of TABLE_SIDE_RELATIONS) {
      const sql = queries.text(DRAWN[relation].query);
      expect(sql, relation).toContain('catalog_owner');
      expect(sql, relation).toContain("'samples'");
      expect(sql, relation).toContain("'__databricks_internal'");
      expect(sql, relation).not.toMatch(/\{\{/);
    }
  });
});

describe('tableSideTopology', () => {
  it('binds the collector cap 101b measured, not a guessed limit', () => {
    const executor = vi.fn(() => Promise.resolve({ data: [] }));
    const collector = tableSideTopology({ executor, lookbackDays: 7, workspaceId: 'ws-1' });

    expect(collector.parameters.topology_limit.value).toBe(String(TOPOLOGY_COLLECTOR_CAP));
    expect(collector.parameters.lookback_days.value).toBe('7');
    expect(collector.parameters.workspace_id.value).toBe('ws-1');
  });

  it('runs each table-side statement and concatenates the edges', async () => {
    const executor = vi.fn((statement: string) => {
      if (statement.includes("entity_type = 'JOB'")) {
        return Promise.resolve({
          data: [{ source_id: '9', target_id: 'main.default.t', last_seen: '2026-08-01T00:00:00.000Z' }],
        });
      }
      return Promise.resolve({ data: [] });
    });

    const edges = await tableSideTopology({ executor }).collectAll();

    expect(executor).toHaveBeenCalledTimes(4);
    expect(edges).toEqual([
      {
        id: 'job-to-table:job:9:table:main.default.t',
        source: 'job:9',
        target: 'table:main.default.t',
        relation: 'job-to-table',
        joinedBy: 'system.access.table_lineage',
        lastSeen: '2026-08-01T00:00:00.000Z',
      },
    ]);
  });

  it('joins warehouse to table on statement_id', () => {
    const sql = files().find((file) => file.name === 'topology_warehouse_to_table')?.sql ?? '';
    expect(sql).toContain('r.statement_id = t.statement_id');
    expect(sql).toContain('compute.warehouse_id');
    expect(sql).not.toContain('compute.cluster_id');
  });
});

describe('the compute-side topology statements', () => {
  it('are the three drawn relations that do not terminate in a table', () => {
    expect([...COMPUTE_SIDE_RELATIONS]).toEqual(
      TOPOLOGY_RELATIONS.filter((relation) => !relation.endsWith('-to-table'))
    );
  });

  it('skips pipeline → cluster for the reason 101b recorded, and ships no file for it', () => {
    expect(COMPUTE_SIDE_SKIPPED).toEqual({
      'pipeline-to-cluster': TOPOLOGY_DECLINED['pipeline-to-cluster'],
    });
    expect(files().map((file) => file.name)).not.toContain('topology_pipeline_to_cluster');
    expect(COMPUTE_SIDE).not.toHaveProperty('pipeline-to-cluster');
  });

  it('joins job → job on the task-run timeline, which is the join 32h got wrong once', () => {
    const sql = files().find((file) => file.name === 'topology_job_to_job')?.sql ?? '';
    expect(sql).toContain('parent.run_id = child.source_task_run_id');
    expect(sql).toContain('system.lakeflow.job_task_run_timeline');
  });

  it('reads cluster and warehouse from the compute struct, not from a bill', () => {
    const cluster = files().find((file) => file.name === 'topology_job_to_cluster')?.sql ?? '';
    const warehouse = files().find((file) => file.name === 'topology_job_to_warehouse')?.sql ?? '';
    expect(cluster).toContain('c.cluster_id');
    expect(warehouse).toContain('c.warehouse_id');
    expect(cluster).not.toContain('system.billing');
    expect(warehouse).not.toContain('system.billing');
  });
});

describe('computeSideTopology', () => {
  it('runs each compute-side statement and concatenates the edges', async () => {
    const executor = vi.fn((statement: string) => {
      if (statement.includes('c.cluster_id')) {
        return Promise.resolve({
          data: [{ source_id: '4', target_id: 'cl-1', last_seen: '2026-08-01T00:00:00.000Z' }],
        });
      }
      return Promise.resolve({ data: [] });
    });

    const edges = await computeSideTopology({ executor }).collectAll();

    expect(executor).toHaveBeenCalledTimes(3);
    expect(edges).toEqual([
      {
        id: 'job-to-cluster:job:4:cluster:cl-1',
        source: 'job:4',
        target: 'cluster:cl-1',
        relation: 'job-to-cluster',
        joinedBy: 'system.lakeflow.job_task_run_timeline',
        lastSeen: '2026-08-01T00:00:00.000Z',
      },
    ]);
  });
});

describe('topology resource names', () => {
  it('reads every name source once, at its latest definition grain', async () => {
    const queries = tableSideQueries();
    const sql = queries.text(TOPOLOGY_NAMES_QUERY);
    expect(sql.match(/system\.lakeflow\.jobs/g)).toHaveLength(1);
    expect(sql.match(/system\.lakeflow\.pipelines/g)).toHaveLength(1);
    expect(sql.match(/system\.compute\.clusters/g)).toHaveLength(1);
    expect(sql.match(/system\.compute\.warehouses/g)).toHaveLength(1);
    expect(grainProblem(sql)).toBeUndefined();

    const executor = vi.fn<SqlExecutor>(() =>
      Promise.resolve({
        data: [
          { kind: 'job', technical_id: '9', name: 'Nightly finance' },
          { kind: 'pipeline', technical_id: 'p-1', name: 'Bronze ingest' },
        ],
      })
    );
    const names = await collectTopologyNames({ executor, workspaceId: 'ws-1' }, [
      { id: 'job:9', kind: 'job', label: 'Job', technicalId: '9' },
      { id: 'pipeline:p-1', kind: 'pipeline', label: 'Pipeline', technicalId: 'p-1' },
      { id: 'table:main.default.t', kind: 'table', label: 'main.default.t', technicalId: 'main.default.t' },
    ]);

    expect(names).toEqual({ 'job:9': 'Nightly finance', 'pipeline:p-1': 'Bronze ingest' });
    const parameters = executor.mock.calls[0]?.[1];
    expect(parameters?.workspace_id.value).toBe('ws-1');
    expect(parameters?.job_ids.value).toBe('9');
    expect(parameters?.pipeline_ids.value).toBe('p-1');
    expect(parameters?.cluster_ids.value).toBe('');
    expect(parameters?.warehouse_ids.value).toBe('');
  });

  it('does not run a name statement for a table-only response', async () => {
    const executor = vi.fn(() => Promise.resolve({ data: [] }));
    await expect(
      collectTopologyNames({ executor }, [
        { id: 'table:main.default.t', kind: 'table', label: 'main.default.t', technicalId: 'main.default.t' },
      ])
    ).resolves.toEqual({});
    expect(executor).not.toHaveBeenCalled();
  });
});
