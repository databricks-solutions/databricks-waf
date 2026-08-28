// What the resources section may say, held against what `LocatedPayload` carries.
//
// The fold is the part worth pinning, because every one of its rules is a sentence about a
// customer's estate. A resource listed twice reads as two resources; a count over a truncated list
// reads as the size of the problem when it is the size of the sample; and a group dropped because
// something above it mentioned the same cluster leaves a true sentence naming half the resources it
// is about. Each of those is tested here in the shape it would ship in.
//
// The auto-termination requirement is the fixture for the first of them because it is the real one:
// `cost.ts` emits two `offenders` rows on that finding, both led *Without it*, one for clusters and
// one for warehouses.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FoundOnSection } from './FoundOn';
import { foundOn } from './found-on';
import type { Evidence, Located, LocatedItem } from '../api/types';

const evidence = (observed: string, at?: Located): Evidence => ({
  signal: 'sql:estate.clusters',
  observed,
  coverage: { mode: 'complete', examined: 12, population: 12 },
  collectedAt: '2026-08-15T09:00:00.000Z',
  ...(at != null ? { bearing: 'detail' as const, at } : {}),
});

const WITHOUT_CLUSTERS: Located = {
  lead: 'Without it',
  items: [
    {
      label: 'etl-nightly',
      in: 'field-eng',
      kind: 'cluster',
      url: 'https://example.databricks.com/compute/clusters/1?o=2',
    },
    // No URL, because the workspace directory does not always resolve one. The fold has to tell it
    // apart from the others on the fields that are left.
    { label: 'shared-adhoc', in: 'field-eng', kind: 'cluster' },
  ],
};

const WITHOUT_WAREHOUSES: Located = {
  lead: 'Without it',
  items: [
    {
      label: 'analytics',
      in: 'field-eng',
      kind: 'warehouse',
      url: 'https://example.databricks.com/sql/warehouses/3?o=2',
    },
  ],
};

const html = (rows: readonly Evidence[], itemHref?: (item: LocatedItem) => string | undefined): string =>
  renderToStaticMarkup(<FoundOnSection evidence={rows} {...(itemHref != null ? { itemHref } : {})} />);

describe('folding a finding’s located evidence', () => {
  it('is absent for a finding that names no resource', () => {
    expect(foundOn([evidence('11 of 11 warehouses auto-stop')])).toBeUndefined();
    expect(html([evidence('11 of 11 warehouses auto-stop')])).toBe('');
  });

  it('reads two rows sharing a lead as one list', () => {
    // Both are "Without it" on the same finding, and two headings with identical words is the
    // reader working out which list they are looking at.
    const found = foundOn([
      evidence('9 of 11 clusters auto-terminate', WITHOUT_CLUSTERS),
      evidence('2 of 3 warehouses auto-stop', WITHOUT_WAREHOUSES),
    ]);

    expect(found?.groups).toHaveLength(1);
    expect(found?.groups[0]?.items.map((item) => item.label)).toEqual(['etl-nightly', 'shared-adhoc', 'analytics']);
  });

  it('names a resource once under a lead, however many rows mention it', () => {
    const found = foundOn([
      evidence('9 of 11 clusters auto-terminate', WITHOUT_CLUSTERS),
      evidence('a second reading of the same clusters', WITHOUT_CLUSTERS),
    ]);

    expect(found?.groups[0]?.items.map((item) => item.label)).toEqual(['etl-nightly', 'shared-adhoc']);
    expect(found?.named).toBe(2);
  });

  it('tells two resources of the same name in different workspaces apart', () => {
    const found = foundOn([
      evidence('one', { lead: 'Without it', items: [{ label: 'etl', in: 'field-eng', kind: 'cluster' }] }),
      evidence('two', { lead: 'Without it', items: [{ label: 'etl', in: 'prod', kind: 'cluster' }] }),
    ]);

    expect(found?.groups[0]?.items).toHaveLength(2);
    expect(found?.named).toBe(2);
  });

  it('tells two resources of the same name and different kinds apart', () => {
    // The auto-termination requirement folds clusters and warehouses under one lead, and nothing
    // stops an estate calling one of each `analytics`. Keyed on the name alone, one of them would
    // leave the list and the count, which is a resource the reader is never told about.
    const found = foundOn([
      evidence('clusters', { lead: 'Without it', items: [{ label: 'analytics', in: 'field-eng', kind: 'cluster' }] }),
      evidence('warehouses', {
        lead: 'Without it',
        items: [{ label: 'analytics', in: 'field-eng', kind: 'warehouse' }],
      }),
    ]);

    expect(found?.groups[0]?.items).toHaveLength(2);
    expect(found?.named).toBe(2);
  });

  it('falls back to the URL on a record written before the kind was carried', () => {
    // ADR 0079: an older record is owed a page that survives it. The route carries the kind, so
    // where there is a link the two are still told apart; where there is not, they fold, and that
    // is a limitation of the record rather than of the fold.
    const found = foundOn([
      evidence('clusters', {
        lead: 'Without it',
        items: [{ label: 'analytics', in: 'field-eng', url: 'https://example/compute/clusters/1?o=2' }],
      }),
      evidence('warehouses', {
        lead: 'Without it',
        items: [{ label: 'analytics', in: 'field-eng', url: 'https://example/sql/warehouses/3?o=2' }],
      }),
    ]);

    expect(found?.groups[0]?.items).toHaveLength(2);
  });

  it('keeps a resource in both lists where two leads are two different facts', () => {
    // Not a duplicate. Dropping `etl-nightly` from the second list would leave a sentence saying
    // which clusters are always on, with one of them missing.
    const found = foundOn([
      evidence('two clusters have no auto-termination', WITHOUT_CLUSTERS),
      evidence('one cluster is always on', {
        lead: 'Always on',
        items: [
          {
            label: 'etl-nightly',
            in: 'field-eng',
            kind: 'cluster',
            url: 'https://example.databricks.com/compute/clusters/1?o=2',
          },
        ],
      }),
    ]);

    expect(found?.groups.map((group) => group.lead)).toEqual(['Without it', 'Always on']);
    expect(found?.groups[1]?.items.map((item) => item.label)).toEqual(['etl-nightly']);
    // Counted once, because it is one resource.
    expect(found?.named).toBe(2);
  });
});

describe('the count beside the heading', () => {
  it('counts the resources named, where the server named all of them', () => {
    expect(html([evidence('9 of 11 clusters auto-terminate', WITHOUT_CLUSTERS)])).toContain('2 named');
  });

  it('is absent where the server truncated, and the disclosure it wrote is not', () => {
    // A count over five of three hundred would be read as the size of the problem. The server's own
    // "and N more" says the opposite, so it is the only number on the section.
    const markup = html([evidence('9 of 300 clusters auto-terminate', { ...WITHOUT_CLUSTERS, more: 298 })]);

    expect(markup).not.toContain('named');
    expect(markup).toContain('and 298 more');
  });

  it('sums what two rows under one lead did not name', () => {
    const found = foundOn([
      evidence('clusters', { ...WITHOUT_CLUSTERS, more: 12 }),
      evidence('warehouses', { ...WITHOUT_WAREHOUSES, more: 3 }),
    ]);

    expect(found?.groups[0]?.more).toBe(15);
    expect(found?.named).toBeUndefined();
  });
});

describe('what the section renders', () => {
  it('names the section for what the field carries, and not for what the brief calls it', () => {
    // ADR 0082. "Blast radius" asserts what inherits the problem, and `LocatedPayload` carries a
    // label, a workspace, a note and a URL — no edge to anything.
    const markup = html([evidence('9 of 11 clusters auto-terminate', WITHOUT_CLUSTERS)]);

    expect(markup).toContain('Resources this was found on');
    expect(markup.toLowerCase()).not.toContain('blast radius');
    expect(markup.toLowerCase()).not.toContain('impact');
  });

  it('links what it can and prints the rest, in the same sentence', () => {
    const markup = html([evidence('9 of 11 clusters auto-terminate', WITHOUT_CLUSTERS)]);

    expect(markup).toContain('href="https://example.databricks.com/compute/clusters/1?o=2"');
    // No link for this one, and no gap where the link would be: the reader sees a name either way.
    expect(markup).toContain('shared-adhoc (field-eng)');
  });

  it('keeps a recorded resource named when its surface refuses the stale destination', () => {
    const markup = html([evidence('9 of 11 clusters auto-terminate', WITHOUT_CLUSTERS)], () => undefined);

    expect(markup).toContain('etl-nightly (field-eng)');
    expect(markup).not.toContain('href="https://example.databricks.com/compute/clusters/1?o=2"');
  });

  it('puts the workspace and the reason outside the link, as the export does', () => {
    const markup = html([
      evidence('one cluster bypasses it', {
        lead: 'Bypassing it',
        items: [{ label: 'dev-cluster', in: 'field-eng', note: 'LEGACY_SINGLE_USER', url: 'https://example/x' }],
      }),
    ]);

    expect(markup).toContain('>dev-cluster</a> (field-eng, LEGACY_SINGLE_USER)');
  });
});
