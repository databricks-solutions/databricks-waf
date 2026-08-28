// The guidance a finding carries, asserted on the HTML it emits.
//
// The property worth pinning is the heading, because it is the one thing on this panel that makes a
// claim about the reader's estate. The advice under it is the same whatever the outcome — the target
// state, what sustaining it costs, what reopens the decision — but "where to get to" printed over a
// passing finding tells a reader there is a gap, one line under a badge saying there is not, and a
// sentence beats a badge. So every outcome gets a heading that is true of it.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FindingGuidancePanel } from './FindingGuidance';
import type { Guidance, GuidanceAdvice, Outcome } from '../api/types';

const ADVICE: GuidanceAdvice = {
  startFrom: 'One serverless warehouse per team, auto-stopping after ten minutes.',
  dependsOn: ['Notebooks mixing SQL with Python need all-purpose compute'],
  path: ['Attribute the current spend before changing anything', 'Point the BI tool at a warehouse'],
  costs: ['Serverless bills at a higher rate per DBU'],
  retain: 'A dated breakdown of DBUs by billing origin product.',
  revisit: 'A new team onboarding.',
};

const GUIDANCE: Guidance = {
  means: 'SQL work runs on a SQL warehouse rather than an all-purpose cluster.',
  matters: 'An all-purpose cluster running a dashboard bills at several times the rate.',
  good: ['BI tools point at a warehouse'],
  examples: { strong: 'All of it.', partial: 'Some of it.', weak: 'None of it.' },
  verify: [{ how: 'sql', where: 'system.billing.usage', expect: 'the billing origin product' }],
  pitfalls: ['A warehouse left running overnight'],
  partialWhen: 'One team has moved and the others have not.',
  lastReviewed: '2026-08-10',
  references: ['https://docs.databricks.com/sql/index.html'],
  advice: ADVICE,
};

const html = (outcome: Outcome, guidance: Guidance = GUIDANCE): string =>
  renderToStaticMarkup(<FindingGuidancePanel guidance={guidance} outcome={outcome} />);

describe('guidance on a finding', () => {
  it('says what the practice is and why, whatever the outcome', () => {
    for (const outcome of ['pass', 'fail', 'not-applicable'] as const) {
      expect(html(outcome), outcome).toContain('SQL work runs on a SQL warehouse');
      expect(html(outcome), outcome).toContain('bills at several times the rate');
    }
  });

  it('offers the advice as a destination when the estate is not there', () => {
    for (const outcome of ['fail', 'partial'] as const) {
      expect(html(outcome), outcome).toContain('Where to get to');
    }
  });

  it('does not tell a passing estate to get somewhere it already is', () => {
    const markup = html('pass');

    expect(markup).not.toContain('Where to get to');
    expect(markup).toContain('What holds this in place');
    // The advice itself is the same. What changed is the claim the heading makes about the reader.
    expect(markup).toContain('One serverless warehouse per team');
    expect(markup).toContain('A new team onboarding');
  });

  it('has a heading for every outcome, so a new one cannot render an empty label', () => {
    const outcomes: readonly Outcome[] = [
      'pass',
      'fail',
      'partial',
      'unmeasurable',
      'not-applicable',
      'satisfied-by-architecture',
    ];

    for (const outcome of outcomes) {
      // `LABEL[outcome]` is typed exhaustively, so this fails at the typecheck before it fails here.
      // Asserted anyway because the failure it guards against renders as a heading over nothing.
      expect(html(outcome), outcome).toMatch(/<p class="wa-label">[^<]+<\/p>/);
    }
  });

  it('shows the two sentences and stops where the entry predates the advice contract', () => {
    const { advice: _dropped, ...older } = GUIDANCE;
    const markup = html('fail', older);

    expect(markup).toContain('SQL work runs on a SQL warehouse');
    expect(markup).not.toContain('Where to get to');
    expect(markup).not.toContain('<details');
  });
});
