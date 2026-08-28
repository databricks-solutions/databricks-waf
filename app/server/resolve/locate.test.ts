import { describe, expect, it } from 'vitest';

import { asCluster, asJob, asPipeline, asTable, asWarehouse, linksIn } from './locate.js';
import type { WorkspaceDirectory, WorkspaceRow } from '../collect/sql/shapes.js';

const HOME: WorkspaceRow = {
  workspaceId: '7000000000000023',
  name: 'labs',
  url: 'https://dbc-example.cloud.databricks.com',
  status: 'RUNNING',
  live: true,
};

const OTHER: WorkspaceRow = {
  workspaceId: '7000000000000018',
  name: 'lab-01',
  url: 'https://dbc-large-estate.example.com',
  status: 'RUNNING',
  live: true,
};

function directory(workspaces: readonly WorkspaceRow[] = [HOME, OTHER]): WorkspaceDirectory {
  return { workspaces, live: workspaces.filter((one) => one.live), excluded: [], regionUnverified: [], outOfScope: [] };
}

describe('linking a finding to the page that fixes it', () => {
  it('addresses a job the way the platform addresses it', () => {
    // Measured, not guessed: a run's own `run_page_url` from the Jobs API reads
    // `https://<host>/?o=<workspaceId>#job/<jobId>/run/<runId>`. Every other route carries the
    // same `o` parameter, for the reader who has four workspaces open at once.
    const link = linksIn(directory());

    expect(link(asJob({ jobId: '471148922192497', workspaceId: HOME.workspaceId }))).toBe(
      'https://dbc-example.cloud.databricks.com/?o=7000000000000023#job/471148922192497'
    );
  });

  it('sends a resource in another workspace to that workspace, not this one', () => {
    // The point of the directory. An account-reach signal returns rows from eleven workspaces, and
    // a link to the right id on the wrong host is worse than no link: it resolves to a 404 inside
    // a workspace the reader may not even have.
    const link = linksIn(directory());

    expect(link(asCluster({ clusterId: '0102-abc', workspaceId: OTHER.workspaceId }))).toBe(
      'https://dbc-large-estate.example.com/compute/clusters/0102-abc?o=7000000000000018'
    );
  });

  it('addresses warehouses, pipelines and tables', () => {
    const link = linksIn(directory());

    expect(link(asWarehouse({ warehouseId: '0123456789abcdef', workspaceId: HOME.workspaceId }))).toBe(
      'https://dbc-example.cloud.databricks.com/sql/warehouses/0123456789abcdef?o=7000000000000023'
    );
    expect(link(asPipeline({ pipelineId: 'a-b-c', workspaceId: HOME.workspaceId }))).toBe(
      'https://dbc-example.cloud.databricks.com/pipelines/a-b-c?o=7000000000000023'
    );
    expect(link(asTable('main.sales.orders', HOME.workspaceId))).toBe(
      'https://dbc-example.cloud.databricks.com/explore/data/main/sales/orders?o=7000000000000023'
    );
  });

  it('escapes a name that would otherwise change the path', () => {
    const link = linksIn(directory());

    expect(link(asTable('main.sales.orders 2024/q1', HOME.workspaceId))).toBe(
      'https://dbc-example.cloud.databricks.com/explore/data/main/sales/orders%202024%2Fq1?o=7000000000000023'
    );
  });

  it('refuses a table name it cannot split into three', () => {
    // A two-part name is a Hive metastore table, which Catalog Explorer addresses differently.
    // Guessing would produce a link to a table that does not exist.
    const link = linksIn(directory());

    expect(link(asTable('legacy.events', HOME.workspaceId))).toBeUndefined();
  });

  it('produces nothing when the directory could not be read', () => {
    // An account that cannot read `workspaces_latest` still gets findings, with prose instead of
    // links. Losing a link must never cost a measurement.
    const link = linksIn(undefined);

    expect(link(asJob({ jobId: '1', workspaceId: HOME.workspaceId }))).toBeUndefined();
  });

  it('produces nothing for a workspace it has no URL for', () => {
    const link = linksIn(directory([{ ...HOME, url: undefined }]));

    expect(link(asJob({ jobId: '1', workspaceId: HOME.workspaceId }))).toBeUndefined();
    expect(link(asJob({ jobId: '1', workspaceId: 'not-in-the-account' }))).toBeUndefined();
    expect(link(asJob({ jobId: '1' }))).toBeUndefined();
  });

  it('produces nothing for a workspace outside the live assessment partition', () => {
    const banned = { ...OTHER, status: 'BANNED', live: false };
    const link = linksIn(directory([HOME, banned]));

    expect(link(asWarehouse({ warehouseId: 'wh-old', workspaceId: banned.workspaceId }))).toBeUndefined();
  });
});
