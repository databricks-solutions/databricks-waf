// The palette's list, rendered, because what makes it usable is its markup.
//
// The keyboard interaction lives in the field above it and is a property of a real browser, so the
// sweep in scripts/check-a11y.mjs owns that. What is asserted here is what a static tree can be wrong
// about: an active option whose id nothing points at, a group heading labelling nothing, a cap that
// truncates in silence, and an outcome printed on a requirement no run reached.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PaletteList } from './PaletteList';
import type { PaletteGroup } from './palette-search';

const GROUPS: readonly PaletteGroup[] = [
  {
    kind: 'page',
    heading: 'Pages',
    entries: [
      {
        kind: 'page',
        id: 'page:/findings',
        label: 'Findings',
        to: '/findings',
        detail: 'Every requirement and its outcome',
        terms: 'findings',
      },
    ],
    hidden: 0,
  },
  {
    kind: 'requirement',
    heading: 'Requirements',
    entries: [
      {
        kind: 'requirement',
        id: 'requirement:CO-01-02',
        label: 'Set up tagging',
        to: '/findings?control=CO-01-02',
        detail: 'Cost optimization · CO-01-02',
        terms: 'co-01-02 set up tagging',
        outcome: 'fail',
      },
      {
        kind: 'requirement',
        id: 'requirement:CO-01-01',
        label: 'Use serverless compute',
        to: '/findings?control=CO-01-01',
        detail: 'Cost optimization · CO-01-01',
        terms: 'co-01-01 use serverless compute',
      },
    ],
    hidden: 6,
  },
];

const list = (over: Partial<Parameters<typeof PaletteList>[0]> = {}): string =>
  renderToStaticMarkup(<PaletteList groups={GROUPS} activeId="requirement:CO-01-02" onPick={() => {}} {...over} />);

describe('PaletteList', () => {
  it('marks exactly one option active, and gives it the id the field points at', () => {
    const markup = list();
    expect([...markup.matchAll(/data-active="true"/g)]).toHaveLength(1);
    // The field's aria-activedescendant is built the same way, so this is the contract between them.
    expect(markup).toContain('id="wa-palette-requirement:CO-01-02"');
    expect(markup).toContain('aria-selected="true"');
  });

  it('labels every group with its own heading', () => {
    const markup = list();
    for (const kind of ['page', 'requirement']) {
      expect(markup).toContain(`aria-labelledby="wa-palette-heading-${kind}"`);
      expect(markup).toContain(`id="wa-palette-heading-${kind}"`);
    }
  });

  it('says how many rows the cap left out rather than stopping in silence', () => {
    expect(list()).toContain('6 more, keep typing');
  });

  it('prints the outcome only where a run reached the requirement', () => {
    const markup = list();
    expect(markup).toContain('Not met');
    // Two requirements are listed and only one was measured, so exactly one verdict is printed.
    expect([...markup.matchAll(/Not met|Met by architecture|Partly met|Unmeasured/g)]).toHaveLength(1);
  });

  it('offers the search-elsewhere row as an option of the listbox, not as a note beside it', () => {
    const markup = list({ fallback: 'Search every requirement for “photon”' });
    expect(markup).toContain('id="wa-palette-elsewhere"');
    expect(markup.slice(markup.indexOf('wa-palette-elsewhere'))).toContain('role="option"');
  });

  it('leaves the elsewhere row out when there is nothing to hand on', () => {
    expect(list()).not.toContain('wa-palette-elsewhere');
  });
});
