// The four figures, rendered, because every defect this surface can have is a defect of wording.
//
// `value.ts` is tested for its arithmetic and `value-language.ts` for its phrases. What is left here is
// the sentence a reader gets when a figure is absent, and an absence is where this component is most at
// risk of saying more than the payload holds: a zero is a count of readings that reached a standing, and
// the tempting sentence beside it — "everything is still failing" — is a claim about the ones that did
// not.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ValueReportView } from './ValueReport';
import type { ValueReport } from '../api/types';

const NONE: ValueReport['outcomes'] = {
  unclaimed: 0,
  awaiting: 0,
  agreed: 0,
  contradicted: 0,
  unmeasured: 0,
  unjudged: 0,
};

const EMPTY: ValueReport = {
  opportunity: [],
  committed: [],
  realised: [],
  cleared: { actions: 0, resources: 0 },
  outcomes: NONE,
};

const render = (over: Partial<ValueReport> = {}): string =>
  renderToStaticMarkup(<ValueReportView value={{ ...EMPTY, ...over }} />);

describe('ValueReportView', () => {
  it('does not read a count of nothing cleared as every finding still being reported', () => {
    // The same zero covers an action nobody has claimed done, one whose resource the latest advisory
    // did not rank, one this build no longer carries the rule for, and an install with no later
    // advisory at all. "Still reports every finding" would be a measurement of all four.
    const markup = render({ cleared: { actions: 0, resources: 0 } });

    expect(markup).toContain('No action here has an advisory reading that stopped reporting the finding');
    expect(markup).not.toContain('still reports every finding');
  });

  it('counts what cleared rather than totalling it, and says why it is not added above', () => {
    const markup = render({ cleared: { actions: 3, resources: 2 } });

    expect(markup).toContain('3 actions on 2 resources');
    expect(markup).toContain('counted here rather than added above');
  });

  it('says why each figure is missing rather than printing a zero', () => {
    // A zero is a measurement and every absence here is the opposite. This is the defect the whole
    // surface exists downstream of, so it is asserted on all four at once.
    const markup = render();

    expect(markup).toContain('no score to restate');
    expect(markup).toContain('No advisor in the latest run priced anything');
    expect(markup).toContain('No action on the board was raised from a finding that carried a price');
    expect(markup).toContain('Nothing on the board has a measure the latest advisory read again');
    expect(markup).not.toMatch(/>0 out of 100</);
  });

  it('reports the actions that did not work beside the ones that did', () => {
    // A page whose only counts are its successes is the list the audit asks not to be given.
    const markup = render({ outcomes: { ...NONE, agreed: 2, contradicted: 1, unmeasured: 4 } });

    expect(markup).toContain('claimed done and still reported');
    expect(markup).toContain('the latest advisory could not read it');
  });

  it('says nothing about outcomes when no action has been raised from advice', () => {
    expect(render()).not.toContain('Every action raised from advice');
  });
});
