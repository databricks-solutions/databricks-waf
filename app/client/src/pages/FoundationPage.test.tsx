// What the readiness page must and must not say, asserted on the HTML it emits.
//
// Two claims are load-bearing and neither is about layout. Every share is rendered beside the
// population it is a share of, because the same coverage measured over two defensible populations
// differed by 20 points on one estate (`45a`); and there is no total, because eight shares of eight
// populations do not have one.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { FoundationReadiness, ReadinessDimension } from '../api/types';
import { Readiness } from './FoundationPage';

function dimension(over: Partial<ReadinessDimension> = {}): ReadinessDimension {
  return {
    id: 'described',
    version: 1,
    area: 'metadata',
    label: 'Described',
    asks: 'How many serving relations carry a description somebody could read.',
    sources: ['sql:serving.population'],
    standing: 'partial',
    bands: { ready: 0.9, partial: 0.6 },
    denominator: { of: 'serving relations', count: 10, excluded: 0, excludedBecause: '' },
    met: 7,
    short: 3,
    unmeasured: 0,
    share: 0.7,
    shortfall: ['main.gold.orders', 'main.gold.customers'],
    ...over,
  };
}

function readiness(over: Partial<FoundationReadiness> = {}): FoundationReadiness {
  return {
    declaration: {
      version: 2,
      declaredAt: '2026-08-15T09:00:00.000Z',
      declaredBy: 'priya@example.com',
      fingerprint: 'sha256:abc',
      named: [{ catalog: 'main', schema: 'gold', table: 'orders' }],
      tagged: [],
      requiredTagKeys: [],
      requiredMetadata: ['description'],
      policy: [],
    },
    population: { assets: 10, missing: 0, truncated: false, undeclared: false },
    dimensions: [dimension()],
    absent: [
      {
        what: 'Whether a Genie space answers correctly.',
        because: 'No endpoint reports it, and this app does not ask questions of a space to find out.',
        measured: 'Read on labs, 2026-08-14: the spaces API returns configuration and no evaluation.',
      },
    ],
    unread: [],
    durable: true,
    ...over,
  };
}

function render(payload: FoundationReadiness): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <Readiness readiness={payload} />
    </MemoryRouter>
  );
}

describe('the readiness page', () => {
  it('prints every share beside the population it is a share of', () => {
    const markup = render(readiness());
    expect(markup).toContain('70%');
    expect(markup).toContain('7 of 10 serving relations');
  });

  it('carries no total over the dimensions, however many are ready', () => {
    const markup = render(
      readiness({
        dimensions: [
          dimension({ id: 'described', share: 1, met: 10, short: 0, standing: 'ready' }),
          dimension({ id: 'owned', label: 'Owned', share: 1, met: 10, short: 0, standing: 'ready' }),
        ],
      })
    );

    // Not a word count: these are the words a summary would have to use, and the page having none of
    // them is what stops the next change from adding one quietly.
    for (const word of ['Overall', 'overall', 'Total', 'Score', 'out of 100']) {
      expect(markup, word).not.toContain(word);
    }
  });

  it('says what counts as serving data before it says how ready any of it is', () => {
    const markup = render(readiness());
    expect(markup.indexOf('What counts as serving data here')).toBeLessThan(markup.indexOf('Described'));
  });

  it('says nothing is declared rather than showing eight failures against a population of none', () => {
    const markup = render(
      readiness({
        declaration: null,
        population: { assets: 0, missing: 0, truncated: false, undeclared: true },
        dimensions: [],
      })
    );
    expect(markup).toContain('Nobody has said which data');
    expect(markup).not.toContain('0%');
    expect(markup).not.toContain('Not read');
    expect(markup).toContain('No serving assets declared');
  });

  it('names the statement that did not answer, and where to find out why', () => {
    const markup = render(
      readiness({ unread: [{ statement: 'sql:serving.facts', kind: 'failed', because: 'timed out at 120s' }] })
    );
    expect(markup).toContain('sql:serving.facts');
    expect(markup).toContain('/diagnostics');
  });

  it('names a few of the relations short of a dimension and counts the rest, rather than listing all', () => {
    const many = Array.from({ length: 9 }, (_, index) => `main.gold.t${String(index)}`);
    const markup = render(readiness({ dimensions: [dimension({ shortfall: many })] }));

    expect(markup).toContain('main.gold.t0');
    expect(markup).toContain('and 4 more');
    expect(markup).not.toContain('main.gold.t8');
  });

  it('shows what the reading does not say with what settled it, so the next reader checks the source', () => {
    const markup = render(readiness());
    expect(markup).toContain('Whether a Genie space answers correctly.');
    expect(markup).toContain('Read on labs, 2026-08-14');
  });

  it('warns that a declaration will not survive a deploy when nothing durable is holding it', () => {
    const markup = render(
      readiness({
        durable: false,
        durabilityNote: 'No database is bound, so this declaration is held in memory and a deploy will erase it.',
      })
    );
    expect(markup).toContain('a deploy will erase it');
  });
});
