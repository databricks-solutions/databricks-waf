// Rendered rather than reasoned about, because the failure mode is in the words.
//
// The component typechecks whichever heading it puts above the sentence, and picking the wrong one
// is the expensive mistake this whole feature exists to avoid: a workspace admin sent to grant an
// ungrantable scope comes back having learnt to ignore the next thing the app tells them. So these
// assertions are on the markup, and specifically on the pair of remedies that must never be
// confused for each other.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { RemedyNote } from './RemedyNote';
import type { Remedy, RemedyKind } from '../api/types';

const WORDS_OF_ADVICE = 'Do the thing.';
const CONTROL = 'SCP-05-07';

function note(over: Partial<Remedy> & { kind: RemedyKind }, controlId = CONTROL): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <RemedyNote remedy={{ says: WORDS_OF_ADVICE, signals: [], ...over }} controlId={controlId} />
    </MemoryRouter>
  );
}

describe('the remedy note', () => {
  it('addresses a missing grant to an admin and a stale consent to the reader', () => {
    // The pair worth asserting together. Both are 403s naming a scope, and the difference is
    // whether the person reading has to raise a ticket or click sign-in — so one names an owner the
    // reader may not be, and the other names nobody, because the reader is it.
    expect(note({ kind: 'grant' })).toContain('a workspace or metastore admin');
    expect(note({ kind: 're-authorise' })).toContain('Sign in again');
  });

  it('names an owner only where the reader might not be it', () => {
    // "Closed by whoever owns the practice." once sat under all 105 findings, below the link that
    // closed them. A line that varies with nothing is furniture, and this one was furniture placed
    // where it drew the eye past the only clickable thing on the pane.
    for (const kind of ['grant', 'enable'] as const) {
      expect(note({ kind }), kind).toMatch(/·\s*a[n]? \w+/);
    }
    for (const kind of ['re-authorise', 'attest', 'retry', 'report'] as const) {
      expect(note({ kind }), kind).not.toContain('·');
    }
  });

  it('never tells a reader to grant something no install can hold', () => {
    const markup = note({ kind: 'attest' });

    expect(markup).toContain('judgement');
    expect(markup).not.toContain('admin');
  });

  it('says "answer" once, in the link that does it', () => {
    // The heading, the advice and the link render three lines and 6px apart. With "Needs an answer
    // from a person" over "An answer scores in place of a measurement" over "Answer this requirement",
    // one word appeared three times inside 108px, and a reader who meets the same word three times in
    // three lines concludes the box has a single idea padded out to fill itself.
    const markup = note({ kind: 'attest', says: 'What you record scores in place of a measurement.' });
    const visible = markup.replace(/<[^>]*>/gu, ' ');

    expect(visible.toLowerCase().match(/answer/gu)?.length ?? 0).toBe(1);
  });

  it('shows the advice, which is what the reader acts on', () => {
    expect(note({ kind: 'grant', says: 'Grant SELECT on system.billing to the scanning identity.' })).toContain(
      'Grant SELECT on system.billing'
    );
  });

  it('opens the answers page on this requirement, not on whichever one sorts first', () => {
    // Two separate bugs have lived in this one attribute, which is why it is asserted character by
    // character rather than by whether a link is present.
    //
    // It first shipped as `/attestations` — the API's path, not the router's — so it 404'd and took
    // the app shell down with it. Then it shipped as a bare `/answers`, which the answers page reads
    // as "nothing selected" and answers by selecting the first of 105 requirements: from any finding
    // but the alphabetically-first, a link reading "Answer this requirement" opened a *different*
    // requirement's form, with its question filled in and a live button to record it. The second
    // survived review because the finding it was demonstrated on happened to sort first.
    expect(note({ kind: 'attest' }, 'IU-01-02')).toContain('href="/answers?control=IU-01-02"');
  });

  it('offers no link where the app has nowhere to send anybody', () => {
    // A grant is issued in the workspace, not here. A link would be inventing a journey.
    for (const kind of ['grant', 're-authorise', 'enable', 'retry', 'report'] as const) {
      expect(note({ kind }), kind).not.toContain('href=');
    }
  });

  it('keeps the platform’s own words behind a disclosure, so the advice is not buried in a stack trace', () => {
    const markup = note({ kind: 'grant', because: 'PERMISSION_DENIED: no SELECT on system.billing' });

    expect(markup).toContain('<details>');
    expect(markup).toContain('PERMISSION_DENIED: no SELECT on system.billing');
  });

  it('says nothing about the platform when the platform said nothing', () => {
    expect(note({ kind: 'attest' })).not.toContain('<details>');
  });

  it('names the signals behind the advice, and says nothing about them when there are none', () => {
    expect(note({ kind: 'grant', signals: ['sql:uc.census', 'rest:jobs.list'] })).toContain('sql:uc.census');
    expect(note({ kind: 'attest' })).not.toContain('Read from');
  });

  it('colours only the two remedies with a cost to doing nothing', () => {
    // Not severity. An ungrantable scope is not a worse problem than a missing grant, it is a
    // different owner, and putting the app's own limits in the same visual channel as the
    // estate's failures would make the coverage summary read as a list of defects.
    for (const kind of ['grant', 're-authorise'] as const) {
      expect(note({ kind })).toContain('wa-callout-warning');
    }
    for (const kind of ['attest', 'report'] as const) {
      expect(note({ kind })).not.toContain('wa-callout-warning');
    }
  });

  it('has a heading for every remedy the server can send', () => {
    // A kind added on the server with no presentation here renders an empty heading, which reads as
    // a rendering defect rather than as the missing case it is.
    const every: readonly RemedyKind[] = ['grant', 're-authorise', 'attest', 'enable', 'retry', 'report'];
    for (const kind of every) {
      expect(note({ kind }), kind).toMatch(/font-semibold[^>]*>\s*[^<\s]/);
    }
  });

  it('ends on what varies rather than on a line every finding shares', () => {
    // The last thing in the box is the last thing read. It has to be either the call to action or
    // something true of this finding alone — not a restatement of the advice above it.
    const markup = note({ kind: 'attest' });
    const tail = markup.slice(markup.lastIndexOf('<p'));

    expect(tail).not.toContain('Closed by');
    expect(markup.lastIndexOf('href=')).toBeGreaterThan(markup.indexOf(WORDS_OF_ADVICE));
  });
});
