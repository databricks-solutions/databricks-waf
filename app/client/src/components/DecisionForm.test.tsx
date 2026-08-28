// Rendered rather than reasoned about.
//
// Everything worth testing in this form lives in an attribute — `disabled`, `max`, `required`, which
// fields exist at all — and every one of those typechecks perfectly while being wrong. The date cap
// is the one that matters most: it is the only thing stopping a reader parking a critical failure for
// a year, and it is a string built from today's date. Server-rendered markup, so no browser needed.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DecisionForm } from './DecisionForm';
import type { Severity } from '../api/types';

const PARK_DAYS: Readonly<Record<Severity, number>> = {
  critical: 90,
  high: 180,
  medium: 365,
  low: 365,
  informational: 365,
};

const html = (element: React.JSX.Element): string => renderToStaticMarkup(element);

const form = (overrides: Partial<React.ComponentProps<typeof DecisionForm>> = {}) =>
  html(
    <DecisionForm
      controlId="DG-02-01"
      severity="critical"
      parkDays={PARK_DAYS}
      hasDecision={false}
      onSubmit={() => undefined}
      saving={false}
      saved={false}
      {...overrides}
    />
  );

describe('a finding nobody has decided about', () => {
  it('preselects no disposition', () => {
    // A form that arrives with "Accepting the risk" ticked collects consent rather than a decision,
    // and the reader who submits it unread has accepted a failure they never considered.
    expect(form()).not.toContain('checked');
  });

  it('cannot be submitted', () => {
    expect(form()).toContain('disabled');
  });

  it('says how much more the reason needs, rather than waiting to reject it', () => {
    expect(form()).toContain('20 more characters');
  });

  it('does not offer to reopen, since there is nothing to withdraw', () => {
    expect(form()).not.toContain('Back on the list');
  });

  it('states what each choice does, including that fixing gets checked', () => {
    const markup = form();

    expect(markup).toContain('The next run checks it');
    expect(markup).toContain('still costs its points');
  });

  it('says it does not change the score, where the choice is made', () => {
    // The property the whole feature rests on. A reader who believes accepting a risk improves the
    // number will use this to improve the number.
    expect(form()).toContain('Does not change the score.');
  });
});

describe('a finding that has already been decided', () => {
  it('offers to reopen', () => {
    expect(form({ hasDecision: true })).toContain('Back on the list');
  });

  it('offers to replace rather than to record', () => {
    expect(form({ hasDecision: true })).toContain('Replace decision');
  });
});

describe('the date a finding may be parked until', () => {
  /*
   * Absent until a disposition is chosen, so these render the field by way of the choice the reader
   * would make. Asserted on the cap rather than on the offered value: the default is a judgement
   * about what to suggest, the maximum is the rule.
   */
  it('is not asked for before a disposition is chosen', () => {
    expect(form()).not.toContain('type="date"');
  });

  it('states the cap in words as well as enforcing it', () => {
    expect(form()).toContain('at most 90 days');
  });

  it('uses the longest interval the server has when the caps did not arrive', () => {
    // A form that offered no maximum would let the reader compose a date the server then refuses,
    // which teaches the rule one rejection at a time.
    expect(form({ parkDays: undefined })).toContain('at most 365 days');
  });
});

describe('the server rejecting a decision', () => {
  it('shows the reason against the form and announces it', () => {
    const markup = form({ error: 'A critical requirement may be parked for at most 90 days.' });

    expect(markup).toContain('at most 90 days.');
    expect(markup).toContain('role="alert"');
  });
});
