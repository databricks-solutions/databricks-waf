// What typing something into ⌘K finds, asserted rather than tried.
//
// Every test here is a way the palette could be worse than the rail it exists to shortcut: an id that
// finds its neighbour, a phrase that finds nothing when the app has an answer, a requirement that only
// appears once a scan has run, a list that stops at twelve without saying so. A palette that gets any
// of those wrong is one the reader stops trusting after the second wrong Enter, and none of them are
// visible in a screenshot.

import { describe, expect, it } from 'vitest';
import { paletteEntries, paletteResults, searchElsewhere } from './palette-search';
import type { SearchableCatalogue, SearchableRun } from './palette-search';

function control(id: string, title: string, criteria?: string) {
  return { id, title, ...(criteria != null ? { criteria } : {}) };
}

const CATALOGUE: SearchableCatalogue = {
  pillars: [
    {
      id: 'cost-optimization',
      code: 'CO',
      title: 'Cost optimization',
      principles: [
        {
          title: 'Choose optimal resources',
          controls: [
            control('CO-01-01', 'Use serverless compute', 'Jobs run on serverless where the workload suits it'),
            control('CO-01-02', 'Set up tagging', 'Every cluster carries an owner tag'),
          ],
        },
        {
          title: 'Monitor and control cost',
          controls: [control('CO-03-01', 'Enable budget alerts'), control('CO-03-07', 'Review spend monthly')],
        },
      ],
    },
    {
      id: 'operational-excellence',
      code: 'OE',
      title: 'Operational excellence',
      principles: [
        {
          title: 'Automate deployments',
          controls: [control('OE-02-06', 'Use infrastructure-as-code')],
        },
      ],
    },
  ],
};

const SCAN: SearchableRun = { findings: [{ controlId: 'CO-01-02', outcome: 'fail' }] };

const all = paletteEntries(CATALOGUE, SCAN);

/** The rows a query returns, flattened, so a test can say what order it expected. */
const found = (query: string, entries = all): readonly string[] =>
  paletteResults(entries, query).flatMap((group) => group.entries.map((entry) => entry.id));

describe('paletteEntries', () => {
  it('reaches every page, pillar and requirement', () => {
    expect(all.filter((entry) => entry.kind === 'pillar')).toHaveLength(2);
    expect(all.filter((entry) => entry.kind === 'requirement')).toHaveLength(5);
    // The rail's own list plus the two pages that are steps inside another page.
    expect(all.filter((entry) => entry.kind === 'page').length).toBeGreaterThan(10);
  });

  it('sends a requirement to the composed investigation for it', () => {
    const entry = all.find((one) => one.id === 'requirement:CO-01-02');
    expect(entry?.to).toBe('/investigate?control=CO-01-02');
  });

  /*
   * The catalogue is the census and the run is what happened to it. A palette built from findings
   * would be empty on a fresh install and would shrink on a partial run — so a reader who scanned one
   * pillar could no longer navigate to the other six, which is the moment they most need to.
   */
  it('carries every requirement with no scan at all, and the outcome only where a run reached one', () => {
    const unscanned = paletteEntries(CATALOGUE);
    expect(unscanned.filter((entry) => entry.kind === 'requirement')).toHaveLength(5);
    expect(unscanned.every((entry) => entry.outcome == null)).toBe(true);

    expect(all.find((one) => one.id === 'requirement:CO-01-02')?.outcome).toBe('fail');
    expect(all.find((one) => one.id === 'requirement:CO-01-01')?.outcome).toBeUndefined();
  });
});

describe('paletteResults', () => {
  it('opens on the pages, so the first ⌘K says what it is for', () => {
    const groups = paletteResults(all, '');
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe('page');
  });

  /*
   * The opening list is a table of contents, so it is in the rail's order and all of it is there. A
   * cap of eight and an alphabetical sort put Answers, Audit trail, Checks, Decisions, Definitions,
   * Diagnostics and Exceptions on screen and hid State of the nation, Pillars, Findings and Report behind a
   * "10 more" — the four pages anybody opens were the four the cap took.
   */
  it('opens on the Dashboard, in the approved task order, and hides none of it', () => {
    const opening = paletteResults(all, '')[0];
    expect(opening?.entries[0]?.to).toBe('/overview');
    expect(opening?.entries.map((entry) => entry.to).slice(0, 7)).toEqual([
      '/overview',
      '/review',
      '/investigate',
      '/workloads',
      '/warehouses',
      '/jobs',
      '/writes',
    ]);
    expect(opening?.hidden).toBe(0);
    for (const to of ['/report', '/history', '/trail', '/retention', '/months']) {
      expect(opening?.entries.some((entry) => entry.to === to)).toBe(true);
    }
  });

  it('finds a requirement by its title', () => {
    expect(found('tagging')).toEqual(['requirement:CO-01-02']);
  });

  it('finds a requirement by words in any order', () => {
    expect(found('serverless use')).toEqual(['requirement:CO-01-01']);
  });

  it('finds a requirement by what it asks for, not only by what it is called', () => {
    // "owner tag" is in the criteria and in no title.
    expect(found('owner tag')).toEqual(['requirement:CO-01-02']);
  });

  /*
   * The reason matching is whole-word substrings rather than a fuzzy score. A palette that answers a
   * fully typed id with its neighbour two rows below it, under a near-identical score, is one where a
   * hurried Enter quotes the wrong requirement in a meeting.
   */
  it('puts an exactly typed id first and does not offer its neighbours', () => {
    expect(found('co-03-01')).toEqual(['requirement:CO-03-01']);
  });

  it('misses a mistyped id rather than guessing at one', () => {
    expect(found('co-03-1')).toEqual([]);
  });

  it('groups the kinds in one order, whatever matched', () => {
    // "cost" is in a page's hint, a pillar's title and a principle's title, so all three answer.
    const groups = paletteResults(all, 'cost');
    expect(groups.map((group) => group.kind)).toEqual(['page', 'pillar', 'requirement']);
  });

  it('ranks a title that starts with the phrase above one that merely contains it', () => {
    const entries = paletteEntries(
      {
        ...CATALOGUE,
        pillars: [
          {
            ...CATALOGUE.pillars[0],
            principles: [
              {
                title: 'x',
                controls: [control('A-2', 'Review the alerts'), control('A-1', 'Alerts are reviewed')],
              },
            ],
          },
        ],
      },
      undefined
    );
    expect(found('alerts', entries)).toEqual(['requirement:A-1', 'requirement:A-2']);
  });

  /*
   * Order does not depend on the run, and that is the opposite of the overview's queue on purpose. A
   * navigator is for reaching something already in mind; a row that moved up because the estate broke
   * overnight is a row the reader's fingers can no longer find.
   */
  it('orders the same whether a run failed a requirement or not', () => {
    expect(found('use', paletteEntries(CATALOGUE, SCAN))).toEqual(found('use', paletteEntries(CATALOGUE)));
  });

  it('caps the requirements and says how many it left out', () => {
    const many = Array.from({ length: 20 }, (_, at) => control(`Z-${String(at)}`, `Zulu ${String(at)}`));
    const entries = paletteEntries(
      {
        ...CATALOGUE,
        pillars: [{ ...CATALOGUE.pillars[0], principles: [{ title: 'z', controls: many }] }],
      },
      undefined
    );
    const group = paletteResults(entries, 'zulu').find((one) => one.kind === 'requirement');
    expect(group?.entries).toHaveLength(12);
    expect(group?.hidden).toBe(8);
  });

  it('ignores case and stray spaces', () => {
    expect(found('  TAGGING ')).toEqual(['requirement:CO-01-02']);
  });
});

describe('searchElsewhere', () => {
  it('hands an unplaceable phrase to the page that searches inside requirements', () => {
    expect(searchElsewhere('photon')?.to).toBe('/findings?q=photon');
  });

  it('offers nothing when nothing was typed', () => {
    expect(searchElsewhere('   ')).toBeUndefined();
  });
});
