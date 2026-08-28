// The first actionable block in a selected requirement, rendered as a customer reads it.

import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { CatalogueControl, Finding, LocatedItem, SelectableWorkspaces } from '../api/types';
import { GapClosure, InvestigationNavigator, InvestigationPrimaryAction } from './InvestigatePage';
import type { InvestigationFocus } from './investigation-focus';

const FINDING: Finding = {
  controlId: 'REL-03-02',
  pillarId: 'reliability',
  principleId: 'REL-03',
  title: 'Enable autoscaling for SQL warehouse',
  outcome: 'fail',
  severity: 'medium',
  coverage: { mode: 'complete', examined: 1, population: 1 },
  evidence: [],
  outcomeReason: 'One busy warehouse cannot add clusters under load.',
};

const CONTROL: CatalogueControl = {
  id: 'REL-03-02',
  title: FINDING.title,
  severity: 'medium',
  provenance: 'waf-docs',
  measurability: 'system-table',
  evaluatorStatus: 'implemented',
  rationale: 'Concurrent queries queue behind a warehouse fixed at one cluster.',
  remediation: {
    summary: 'Set a scaling range and a short auto-stop on each warehouse.',
    docUrl: 'https://docs.databricks.com/aws/en/compute/sql-warehouse/create',
  },
};

const RESOURCE: LocatedItem = {
  kind: 'warehouse',
  label: 'Analytics warehouse',
  url: 'https://dbc.example/sql/warehouses/wh-1?o=w1',
};

const CURRENT: SelectableWorkspaces = {
  asOf: '2026-08-22T00:00:00.000Z',
  workspaces: [{ id: 'w1', name: 'Analytics', url: 'https://dbc.example', status: 'RUNNING', assessable: true }],
};

function closure(
  resources: readonly LocatedItem[] = [RESOURCE],
  workspaceDirectory: SelectableWorkspaces | undefined = CURRENT
): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <GapClosure finding={FINDING} control={CONTROL} resources={resources} workspaceDirectory={workspaceDirectory} />
    </MemoryRouter>
  );
}

describe('the selected requirement closure action', () => {
  it('leads with one do-this, one why and the governed remediation handoff', () => {
    const markup = closure();

    expect(markup).toContain('Do this');
    expect(markup).toContain('data-customer-action="recommendation"');
    expect(markup).toContain('Set a scaling range and a short auto-stop');
    expect(markup).toContain('One busy warehouse cannot add clusters under load.');
    expect(markup).not.toContain('Concurrent queries queue');
    expect(markup).toContain('href="/improvements?control=REL-03-02"');
    expect(markup).toContain('Create improvement plan');
    expect(markup).toContain('Assign in the improvement plan');
    expect(markup).toContain('A later assessment will evaluate this requirement again');
  });

  it('opens the one exact affected resource and the Databricks guide', () => {
    const markup = closure();

    expect(markup).toContain('href="https://dbc.example/sql/warehouses/wh-1?o=w1"');
    expect(markup).toContain('Open in Databricks');
    expect(markup).toContain('href="https://docs.databricks.com/aws/en/compute/sql-warehouse/create"');
  });

  it('does not offer a vague resource button when several exact resources were named', () => {
    expect(
      closure([
        RESOURCE,
        { ...RESOURCE, label: 'Finance warehouse', url: 'https://dbc.example/sql/warehouses/wh-2?o=w1' },
      ])
    ).not.toContain('Open in Databricks');
  });

  it('uses governed remediation when the latest directory records the workspace as banned', () => {
    const markup = closure([RESOURCE], {
      asOf: '2026-08-22T00:00:00.000Z',
      workspaces: [
        {
          id: 'w1',
          name: 'Analytics',
          url: 'https://dbc.example',
          status: 'BANNED',
          assessable: false,
          reason: 'not-running',
        },
      ],
    });

    expect(markup).toContain('class="wa-button-primary" href="/improvements?control=REL-03-02"');
    expect(markup).toContain('workspace directory records its workspace as banned as of 2026-08-22');
    expect(markup).not.toContain('href="https://dbc.example/sql/warehouses/wh-1?o=w1"');
    expect(markup).not.toContain('Open in Databricks');
  });

  it('does not claim an unverified destination is stale', () => {
    const markup = closure([RESOURCE], { workspaces: [], unavailable: 'The workspace directory could not be read.' });

    expect(markup).toContain('current destination could not be verified');
    expect(markup).not.toContain('no longer');
    expect(markup).not.toContain('Open in Databricks');
  });
});

describe('the selected requirement primary section', () => {
  it('keeps the action and typed affected resources in the same opening section', () => {
    const focus: InvestigationFocus = {
      resources: [RESOURCE],
      nodes: [],
      edges: [],
      selectedNodeIds: new Set(),
    };
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <InvestigationPrimaryAction
          finding={FINDING}
          control={CONTROL}
          focus={focus}
          workspaceDirectory={CURRENT}
          selectedNodeId={null}
          onReloadTopology={() => undefined}
          onNode={() => undefined}
        />
      </MemoryRouter>
    );

    expect(markup).toContain('Set a scaling range and a short auto-stop');
    expect(markup).toContain('Affected resources');
    expect(markup).toContain('Analytics warehouse');
    expect(markup).toContain('Open in Databricks');
  });

  it('keeps an expected topology refusal visible as unavailable relationship context', () => {
    const focus: InvestigationFocus = {
      resources: [RESOURCE],
      nodes: [],
      edges: [],
      selectedNodeIds: new Set(),
    };
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <InvestigationPrimaryAction
          finding={FINDING}
          control={CONTROL}
          focus={focus}
          workspaceDirectory={CURRENT}
          selectedNodeId={null}
          topologyError="Topology collection is not configured."
          onReloadTopology={() => undefined}
          onNode={() => undefined}
        />
      </MemoryRouter>
    );

    expect(markup).toContain('Relationship context is unavailable');
    expect(markup).toContain('Try context again');
  });

  it('does not create generic compliance work for an unmeasurable result with no remedy', () => {
    const focus: InvestigationFocus = {
      resources: [],
      nodes: [],
      edges: [],
      selectedNodeIds: new Set(),
    };
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <InvestigationPrimaryAction
          finding={{ ...FINDING, outcome: 'unmeasurable' }}
          control={CONTROL}
          focus={focus}
          selectedNodeId={null}
          onReloadTopology={() => undefined}
          onNode={() => undefined}
        />
      </MemoryRouter>
    );

    expect(markup).toContain('No safe action is recorded.');
    expect(markup).not.toContain('/improvements');
  });
});

describe('the investigation navigator', () => {
  it('leads with publication meaning without result or source-run identifiers', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <InvestigationNavigator
          finalisedAt="2026-08-21T04:46:00.000Z"
          pillars={[]}
          selectedPillar="all"
          outcome="all"
          change="all"
          changes={[]}
          pillarTitle={(id) => id}
          onPillar={() => undefined}
          onOutcome={() => undefined}
          onChange={() => undefined}
        />
      </MemoryRouter>
    );

    expect(markup).toContain('Published report');
    expect(markup).toContain('Published');
    expect(markup).toContain('Filter requirements by pillar');
    expect(markup).toContain('Filter requirements by outcome');
    expect(markup).toContain('Filter requirements by movement');
    expect(markup).not.toContain('wa-record-list');
    expect(markup).not.toContain('Result ');
    expect(markup).not.toContain('source run');
  });
});
