// The acceptance form, rendered, because what it refuses is the reason the record is worth keeping.
//
// The server refuses all of it too, and that is not a reason to skip these. A form that offers a
// choice the server rejects teaches the reader that the form cannot be trusted, and the reader who
// learns that stops reading the help text — including the part explaining what the compensating
// control field is for, which is the one field this whole record exists to collect.
//
// So each test is a version of this form that would collect the wrong thing: one that offers to
// accept a critical requirement for a year; one that offers a residual above the severity it is left
// over from; one that lets "n/a" through with advice to type more characters; one that asks for the
// compensating control and the reason in a single box.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AcceptRiskForm, type AcceptRiskFormProps } from './AcceptRiskForm';
import type { Severity } from '../api/types';

const DAYS: Readonly<Record<Severity, number>> = {
  critical: 30,
  high: 90,
  medium: 180,
  low: 365,
  informational: 365,
};

const render = (over: Partial<AcceptRiskFormProps> = {}): string =>
  renderToStaticMarkup(
    <AcceptRiskForm
      controlId="SEC-03-02"
      severity="high"
      acceptanceDays={DAYS}
      onSubmit={() => undefined}
      saving={false}
      saved={false}
      {...over}
    />
  );

/** The `max` on the expiry input, which is what stops a date the server would refuse being offered. */
const maxExpiry = (markup: string): string | undefined =>
  /id="risk-until-SEC-03-02"[^>]*?max="([^"]+)"/.exec(markup)?.[1] ??
  /max="([^"]+)"[^>]*?id="risk-until-SEC-03-02"/.exec(markup)?.[1];

describe('AcceptRiskForm', () => {
  it('asks why and what is holding the line as two questions', () => {
    const markup = render();

    // One box collects the first of these, because it is the honest answer to the prompt. The record
    // exists for the second.
    expect(markup).toContain('Why the requirement is not met');
    expect(markup).toContain('What is holding the line instead');
  });

  it('caps the expiry at the requirement’s own severity, before the reader presses the button', () => {
    const critical = maxExpiry(render({ severity: 'critical' }));
    const low = maxExpiry(render({ severity: 'low' }));

    expect(critical).toBeDefined();
    expect(low).toBeDefined();
    // A critical requirement cannot be accepted for as long as a low one, and the input says so
    // rather than the server saying so afterwards.
    expect(String(critical) < String(low)).toBe(true);
  });

  it('names how long this severity may be accepted for, in words', () => {
    expect(render({ severity: 'critical' })).toContain('at most 30 days at a time');
  });

  it('offers no residual risk above the severity it is left over from', () => {
    // An acceptance claiming more residual risk than the requirement carries is an escalation, and
    // the server refuses it — so it is not on the form.
    const markup = render({ severity: 'medium' });

    expect(markup).toContain('value="medium"');
    expect(markup).toContain('value="low"');
    expect(markup).not.toContain('value="critical"');
    expect(markup).not.toContain('value="high"');
  });

  it('preselects no residual risk, since the one that would get chosen is the smallest', () => {
    expect(render()).not.toContain('checked=""');
  });

  it('says the residual may not exceed what the requirement carries, and why', () => {
    expect(render()).toContain('escalation rather than an acceptance');
  });

  it('refuses to be submitted empty', () => {
    // Disabled until every field is answered, rather than submitting and rendering the server's list.
    expect(render()).toContain('disabled=""');
  });

  it('will not offer a start date in the past', () => {
    const markup = render();
    const min = /id="risk-from-SEC-03-02"[^>]*?min="([^"]+)"/.exec(markup)?.[1];

    expect(min).toBe(new Date().toISOString().slice(0, 10));
    expect(markup).toContain('cannot be backdated');
  });

  it('says there is no edit before the reader writes one, not after', () => {
    // Alongside the score, because both are properties of the record a reader needs before they
    // commit to it: one is what makes it safe, the other is what makes it worth keeping.
    expect(render()).toContain('Does not change the score. Cannot be edited afterwards');
  });

  it('does not offer to replace an acceptance, which the server refuses by design', () => {
    // It used to. A requirement carries one acceptance at a time, so a reader who filled this form in
    // while another was in force got their work back with "revoke that one" written under it. The panel
    // no longer opens the form in that case, and the button no longer promises the move.
    const markup = render();

    expect(markup).toContain('Accept the risk');
    expect(markup).not.toContain('Replace acceptance');
  });

  it('shows the server’s refusal against the form rather than nowhere', () => {
    const markup = render({ error: 'This requirement is already accepted until 30 June.' });

    expect(markup).toContain('already accepted until 30 June');
    expect(markup).toContain('role="alert"');
  });

  it('falls back to the longest cap where the payload arrives without one', () => {
    // The longest rather than the shortest: a form that offers a date the server may refuse costs a
    // round trip, and one that refuses a date the server would accept is a form telling a lie about
    // the rule.
    expect(render({ acceptanceDays: undefined, severity: undefined })).toContain('at most 365 days');
  });
});
