// The scope preview, asserted on the HTML it emits.
//
// Three properties here are the panel's whole reason for existing, and each of them is only visible
// on screen.
//
// A stale count is worse than no count. The panel is fed by a debounced request, so between a reader
// ticking a workspace and the answer arriving there is a window where the previous answer is still in
// hand — and it describes the selection they just abandoned. What renders in that window is the test
// below, because "7 workspaces" under a scope of eight is a number somebody would act on.
//
// The omitted workspaces are named rather than counted. "Four would not be measured" leaves the
// reader to work out which four from a picker of two hundred, and the point of the panel is that one
// of the four is usually a surprise.
//
// An unresolved scope is not an empty one. With no directory to hold the scope against, the lists are
// empty for a reason that has nothing to do with the scope, and a panel that rendered its success tone
// over "covers 0 workspaces" would report a measurement it had not made.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScopePreview } from './ScopePreview';
import type { ScopePreview as Preview } from '../api/types';

function preview(over: Partial<Preview> = {}): Preview {
  return {
    assessed: [{ workspaceId: 'w1', name: 'analytics-prod' }],
    omitted: [],
    outOfScope: 0,
    complete: true,
    description: 'Assessed across 1 workspace of the 3 this account has.',
    ...over,
  };
}

describe('ScopePreview', () => {
  it('shows the working state instead of the answer it is about to replace', () => {
    const html = renderToStaticMarkup(
      <ScopePreview preview={preview({ description: 'Assessed across 7 workspaces.' })} loading />
    );

    expect(html).toContain('Working out what this covers');
    expect(html).not.toContain('7 workspaces');
  });

  it('says why there is no answer, in place of the answer', () => {
    const html = renderToStaticMarkup(
      <ScopePreview
        loading={false}
        preview={preview({
          assessed: [],
          complete: false,
          description: 'What this scope covers is not known yet.',
          unavailable: 'No scan has run yet, so there is no account directory to resolve this scope against.',
        })}
      />
    );

    expect(html).toContain('No scan has run yet');
    expect(html).not.toContain('not known yet');
  });

  /*
   * The date is suppressed for an unresolved scope on purpose. "Held against the directory as the last
   * scan read it" beneath a sentence saying there is no directory is a contradiction the reader has to
   * resolve, and they cannot.
   */
  it('dates the directory it resolved against, and only when it resolved against one', () => {
    const asOf = new Date('2026-07-30T02:00:00Z').toISOString();

    expect(renderToStaticMarkup(<ScopePreview loading={false} preview={preview({ asOf })} />)).toContain(
      'as the last scan read it'
    );
    expect(
      renderToStaticMarkup(
        <ScopePreview loading={false} preview={preview({ asOf, unavailable: 'Nothing to resolve against.' })} />
      )
    ).not.toContain('as the last scan read it');
  });

  it('names the workspaces a scope would miss rather than counting them', () => {
    const html = renderToStaticMarkup(
      <ScopePreview
        loading={false}
        preview={preview({
          complete: false,
          omitted: [
            { workspaceId: 'w9', name: 'legacy-eu', reason: 'other-region' },
            { workspaceId: 'w8', reason: 'not-running' },
          ],
        })}
      />
    );

    expect(html).toContain('2 would not be measured');
    expect(html).toContain('legacy-eu');
    // Unnamed in the directory, so the id is the only thing there is to call it by. Rendering nothing
    // would leave a bullet the reader cannot act on.
    expect(html).toContain('w8');
  });

  it('says the failure rather than an empty scope when the preview could not be fetched', () => {
    const html = renderToStaticMarkup(<ScopePreview loading={false} error="The last scan could not be read." />);

    expect(html).toContain('The last scan could not be read.');
    expect(html).toContain('role="alert"');
  });

  it('invites a scope when none has been asked about', () => {
    expect(renderToStaticMarkup(<ScopePreview loading={false} />)).toContain('Choosing a scope');
  });
});
