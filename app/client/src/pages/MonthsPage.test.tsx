// The monthly page's claims, asserted on the HTML it emits.
//
// ADR 0072 enumerates what must differ either side of publish: a named preview sentence, no digest
// until something is frozen, publish versus supersede, standing that does not invent a unique current
// copy, and the digest caveat that must not imply origin. Layout is not what these tests are for.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { MonthContent, MonthPreview, PublishedMonth } from '../api/types';
import { MonthFigures, PublishedHeader, PublishAction } from './MonthView';
import { viewedPublicationId } from './MonthsPage';
import { PREVIEW_NOTE } from './month-language';

const DIGEST = 'sha256:0f4a1e2b3c4d5e6f70819293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7';

function content(over: Partial<MonthContent> = {}): MonthContent {
  return {
    runHealth: [{ label: 'Assessment runs', value: '2' }],
    findingDeltas: [],
    movement: [{ label: 'Overall score', from: '68', to: '72' }],
    actions: [{ label: 'Actions raised', value: '1' }],
    exceptions: [],
    outcomes: [
      { label: 'Met', value: '10' },
      { label: 'Failing', value: '3' },
    ],
    review: [{ label: 'Review', value: 'Finalised by ana@example.com' }],
    trend: [
      { month: '2026-06', label: 'June 2026', score: '68', comparability: 'permitted' },
      {
        month: '2026-07',
        label: 'July 2026',
        score: '72',
        comparability: 'refused',
        note: 'The catalogue version changed.',
      },
    ],
    ...over,
  };
}

function preview(over: Partial<MonthPreview> = {}): MonthPreview {
  return {
    month: '2026-07',
    label: 'July 2026',
    durable: true,
    closed: true,
    eligibility: { eligible: true, state: 'eligible' },
    zone: { id: 'UTC', source: 'schedule' },
    content: content(),
    ...over,
  };
}

function publication(over: Partial<PublishedMonth> = {}): PublishedMonth {
  return {
    id: 'pub-1',
    ordinal: 1,
    total: 1,
    current: true,
    publishedAt: '2026-09-01T09:00:00.000Z',
    publishedBy: 'priya@example.com',
    documentVersion: 1,
    digest: DIGEST,
    ...over,
  };
}

describe('preview', () => {
  it('carries the named preview sentence and no digest', () => {
    const markup = renderToStaticMarkup(
      <PublishAction preview={preview()} label="July 2026" working={false} onPublish={() => undefined} />
    );
    expect(PREVIEW_NOTE).toContain('as it stands');
    expect(markup).toContain('Publish July 2026');
    expect(markup).not.toContain('sha256:');
  });

  it('disables publish on an open month and shows the server closure sentence', () => {
    const closedNote =
      'August 2026 has not ended yet in UTC, the timezone the deployed schedule carries. A month is publishable only once it has closed, so that what it reports cannot change after it is frozen.';
    const markup = renderToStaticMarkup(
      <PublishAction
        preview={preview({
          month: '2026-08',
          label: 'August 2026',
          closed: false,
          closedNote,
          availableFrom: '1 September 2026',
        })}
        label="August 2026"
        working={false}
        onPublish={() => undefined}
      />
    );
    expect(markup).toContain(closedNote);
    expect(markup).toContain('disabled');
    expect(markup).not.toMatch(/workspace timezone/i);
  });

  it('disables publish on a closed month whose run has an unfinished review, and says which', () => {
    const unreviewedNote =
      'July 2026 closed on the run finished 31 Jul 2026, 23:50 UTC, whose review is not finished — 1 of 7 pillars have a record. ' +
      'A published month is frozen, so it is published once somebody has confirmed or skipped every pillar of ' +
      'the run it reports.';
    const markup = renderToStaticMarkup(
      <PublishAction
        preview={preview({
          eligibility: {
            eligible: false,
            state: 'incomplete',
            reason: { code: 'review-incomplete', message: unreviewedNote, action: 'Complete the review and retry.' },
          },
        })}
        label="July 2026"
        working={false}
        onPublish={() => undefined}
      />
    );
    expect(markup).toContain('1 of 7 pillars have a record');
    expect(markup).toContain('disabled');
  });

  it('leads a blocked month with the exact review and keeps the run id as provenance', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <PublishAction
          preview={preview({
            reviewId: 'review-july',
            closingRun: { id: '3896dbcf-69c9-4233-bc0a-482ba2fc7218', finishedAt: '2026-07-31T23:50:00.000Z' },
            eligibility: {
              eligible: false,
              state: 'incomplete',
              reason: {
                code: 'review-incomplete',
                message: 'The run finished 31 Jul 2026, 23:50 UTC and its review is incomplete.',
                action: 'Confirm or explicitly skip every pillar.',
              },
            },
          })}
          label="July 2026"
          working={false}
          onPublish={() => undefined}
        />
      </MemoryRouter>
    );

    expect(markup).toContain('href="/review/review-july"');
    expect(markup.indexOf('Continue this review')).toBeLessThan(markup.indexOf('Technical run provenance'));
    expect(markup).toContain('3896dbcf-69c9-4233-bc0a-482ba2fc7218');
  });

  it('disables publish when the closing run is pre-release evidence', () => {
    const methodologyNote =
      'July 2026 closed on run scan-2026-07, which records no public methodology release. ' +
      'It is pre-release development evidence and cannot be published as Methodology Version 1.';
    const markup = renderToStaticMarkup(
      <PublishAction
        preview={preview({
          eligibility: {
            eligible: false,
            state: 'incomplete',
            reason: {
              code: 'methodology-not-released',
              message: methodologyNote,
              action: 'Run the released methodology and retry.',
            },
          },
        })}
        label="July 2026"
        working={false}
        onPublish={() => undefined}
      />
    );

    expect(markup).toContain('pre-release development evidence');
    expect(markup).toContain('disabled');
  });

  it('does not offer publish when the install cannot keep a publication', () => {
    const markup = renderToStaticMarkup(
      <PublishAction
        preview={preview({ durable: false })}
        label="July 2026"
        working={false}
        onPublish={() => undefined}
      />
    );
    expect(markup).not.toContain('Publish July 2026');
  });
});

describe('figures', () => {
  it('reports the review the month was published under', () => {
    const markup = renderToStaticMarkup(<MonthFigures content={content()} />);
    expect(markup).toContain('Finalised by ana@example.com');
  });

  it('says an empty review section is a missing record, not that nobody reviewed it', () => {
    const markup = renderToStaticMarkup(<MonthFigures content={content({ review: [] })} />);
    expect(markup).toContain('holds no review record');
    expect(markup).not.toMatch(/not reviewed|nobody reviewed/i);
  });

  it('says nothing about a review for a document frozen before the section existed', () => {
    const markup = renderToStaticMarkup(<MonthFigures content={content({ review: undefined })} />);
    expect(markup).not.toMatch(/review/i);
  });
});

describe('published', () => {
  it('shows the digest, who acted, and that acting is not approval', () => {
    const markup = renderToStaticMarkup(<PublishedHeader publication={publication()} month="2026-07" />);
    expect(markup).toContain(DIGEST);
    expect(markup).toContain('priya@example.com');
    expect(markup).toContain('not approval');
    expect(markup).toContain('not a signature');
    expect(markup).not.toMatch(/who wrote it.*priya/i);
  });

  it('names a superseded copy as superseded rather than current', () => {
    const markup = renderToStaticMarkup(
      <PublishedHeader
        publication={publication({
          ordinal: 1,
          total: 2,
          current: false,
          supersededAt: '2026-09-12T00:00:00.000Z',
        })}
        month="2026-07"
      />
    );
    expect(markup).toContain('Publication 1 of 2, superseded on 12 September 2026.');
    expect(markup).not.toMatch(/\bthe current\b/i);
  });

  it('offers the frozen files as downloads, not in-app routes', () => {
    const markup = renderToStaticMarkup(<PublishedHeader publication={publication()} month="2026-07" />);
    expect(markup).toContain('/api/months/2026-07/publications/pub-1.json');
    expect(markup).toContain('/api/months/2026-07/publications/pub-1.csv');
    expect(markup).toContain('download');
  });
});

describe('which copy the page shows', () => {
  it('keeps a requested id that is still in the month, even after a later copy exists', () => {
    const publications = [{ id: 'pub-1' }, { id: 'pub-2' }];
    expect(viewedPublicationId('pub-1', publications)).toBe('pub-1');
    expect(viewedPublicationId('pub-2', publications)).toBe('pub-2');
    expect(viewedPublicationId(undefined, publications)).toBe('pub-2');
    expect(viewedPublicationId('gone', publications)).toBe('pub-2');
  });
});

describe('figures', () => {
  it('draws a refused trend point with its reason rather than dropping it', () => {
    const markup = renderToStaticMarkup(<MonthFigures content={content()} />);
    expect(markup).toContain('data-comparability="refused"');
    expect(markup).toContain('The catalogue version changed.');
    expect(markup).toContain('Not comparable');
    expect(markup).toContain('June 2026');
    expect(markup).toContain('72');
  });

  it('restates movement from both ends', () => {
    const markup = renderToStaticMarkup(<MonthFigures content={content()} />);
    expect(markup).toContain('Overall score');
    expect(markup).toContain('68');
    expect(markup).toContain('72');
  });

  it('names its sections at level two, because the plane above them is a landmark and not a heading', () => {
    // `check:a11y` reads this one on `/months`, which is the only page in the app whose detail pane is
    // open on arrival — and the only reason this skip was the one of five that got found. Pinned here
    // too, so a change to these seven headings fails in `npm run verify` and not only under a sweep
    // that needs a dev server, a scan and a Chrome.
    const markup = renderToStaticMarkup(<MonthFigures content={content()} />);

    expect(markup).toContain('<h2 class="wa-label-eyebrow text-wa-text">Run health</h2>');
    expect(markup).not.toMatch(/<h[3456]/);
  });
});
