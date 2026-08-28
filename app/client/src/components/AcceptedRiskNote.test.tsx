// What an acceptance says, rendered, because every defect this record can have is a defect of wording.
//
// The record is well-formed by construction — the server refuses one without a compensating control,
// without an expiry, or with a residual above the requirement's severity. What it cannot refuse is a
// rendering that reads as though the problem were solved. So each of these tests is a version of this
// block that would mislead: one that shows a residual without what it was reduced from; one that says
// "Expires 4 August" about a date in July; one where the reason has crowded out the only sentence a
// reviewer came for.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AcceptedRiskNote } from './AcceptedRiskNote';
import type { AcceptedRisk } from '../api/types';

const IN_FORCE: AcceptedRisk = {
  id: 'risk-1',
  controlId: 'SEC-03-02',
  reason: 'The identity provider cannot issue short-lived tokens until the upgrade in the third quarter.',
  compensatingControl:
    'Access is restricted to two named service principals, and their use is reviewed weekly against the audit log by the platform team.',
  residual: 'medium',
  owner: 'platform-engineering',
  effectiveFrom: '2026-04-01T00:00:00.000Z',
  expiresAt: '2026-06-30T23:59:59.999Z',
  recordedBy: 'ana@example.com',
  recordedAt: '2026-04-01T09:00:00.000Z',
  standing: 'active',
  effective: true,
  title: 'Tokens are short-lived',
  pillarId: 'security',
  severity: 'high',
};

const render = (over: Partial<AcceptedRisk> = {}): string =>
  renderToStaticMarkup(<AcceptedRiskNote risk={{ ...IN_FORCE, ...over }} />);

describe('AcceptedRiskNote', () => {
  it('leads with what is holding the line, which is what a reviewer came for', () => {
    const markup = render();
    const control = markup.indexOf('What is in place instead');
    const reason = markup.indexOf('Why the requirement is not met');

    expect(control).toBeGreaterThan(-1);
    // Above the reason, deliberately: a reader who takes in the reason first has formed a view on
    // whether the exposure is tolerable before reading the only sentence that bears on it.
    expect(control).toBeLessThan(reason);
  });

  it('quotes the compensating control rather than summarising it', () => {
    expect(render()).toContain('reviewed weekly against the audit log by the platform team');
  });

  it('never states a residual risk without what it was reduced from', () => {
    // "Residual: low" on a critical requirement is the claim this record exists to make checkable,
    // and it is only checkable beside the severity it came down from.
    expect(render()).toContain('Residual risk: medium, down from high');
  });

  it('says so when the residual is the requirement’s own severity, rather than implying a reduction', () => {
    // Split around the apostrophe, which the renderer escapes.
    const markup = render({ residual: 'high' });

    expect(markup).toContain('Residual risk: high, unchanged from the requirement');
    expect(markup).toContain('own severity');
  });

  it('names who is answerable and who accepted it, which are allowed to differ', () => {
    const markup = render();

    expect(markup).toContain('Accepted by ana@example.com');
    expect(markup).toContain('Answerable: platform-engineering');
  });

  it('says an expiry has passed in the past tense', () => {
    // The defect this prevents: "Expires 30 June" reads at a glance like a date still ahead, and an
    // expired acceptance is the one row that is holding nothing.
    const markup = render({ standing: 'expired', effective: false });

    expect(markup).toMatch(/Expired \d+ days? ago/);
    expect(markup).not.toContain('Expires 30');
  });

  it('says the requirement is back on the queue when the acceptance has expired', () => {
    expect(render({ standing: 'expired', effective: false })).toContain('back on the queue');
  });

  it('does not call an acceptance in force a pass', () => {
    const markup = render();

    // The whole risk of this record is that it reads as though the problem were solved. The score is
    // named because a reader who thinks an exception fixes the number will accept things to move it.
    expect(markup).toContain('still unmet and still costs its points');
    expect(markup).not.toContain('requirement is met');
    expect(markup).not.toContain('Passed');
  });

  it('says a pending acceptance is not holding anything yet', () => {
    const markup = render({ standing: 'pending', effective: false });

    expect(markup).toContain('In force from');
    expect(markup).toContain('still on the queue');
  });

  it('carries the reason it was ended early, because that is why the queue changed', () => {
    const markup = render({
      standing: 'revoked',
      effective: false,
      revoked: {
        by: 'sam@example.com',
        at: '2026-05-02T10:00:00.000Z',
        reason: 'The upgrade landed early, so the requirement can be met now.',
      },
    });

    expect(markup).toContain('Ended early by sam@example.com');
    expect(markup).toContain('The upgrade landed early');
  });

  it('keeps a replaced acceptance readable rather than reading as current', () => {
    const markup = render({ standing: 'superseded', effective: false });

    expect(markup).toContain('replaced this one');
    expect(markup).toContain('how long the exposure has been carried');
    // Not the present tense about a record that is holding nothing.
    expect(markup).toContain('Would have expired');
  });

  it('reads an unrecordable expiry as unreadable rather than as an epoch date', () => {
    expect(render({ expiresAt: 'not a date' })).toContain('could not be read');
  });
});
