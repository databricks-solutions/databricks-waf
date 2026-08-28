// The advice panel, asserted on the HTML it emits.
//
// Two properties are worth pinning and both are decisions a later reader tidying the layout would
// undo. The staged route is visible without a click, because a reader who has just been told their
// estate does not do this needs somewhere to stand between here and the target more than they need
// anything else on the panel. And the cost has its own heading rather than trailing the
// recommendation, because a cost folded into advice reads as a caveat on it and a cost with a
// heading is something the reader weighs.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GuidanceAdvicePanel } from './GuidanceAdvicePanel';
import type { GuidanceAdvice } from '../api/types';

const ADVICE: GuidanceAdvice = {
  startFrom: 'One serverless warehouse per team, auto-stopping after ten minutes.',
  dependsOn: ['Notebooks mixing SQL with Python need all-purpose compute', 'A hard concurrency floor wants a pro warehouse'],
  path: ['Attribute the current spend before changing anything', 'Point the BI tool at a warehouse', 'Then move the policy'],
  costs: ['Serverless bills at a higher rate per DBU', 'Cluster policies are somebody’s ongoing job'],
  retain: 'A dated breakdown of DBUs by billing origin product, before and after.',
  revisit: 'A new team onboarding, or the all-purpose share rising two months running.',
};

const html = (advice: GuidanceAdvice = ADVICE): string =>
  renderToStaticMarkup(<GuidanceAdvicePanel advice={advice} label="Where to get to" />);

describe('the advice panel', () => {
  it('shows the recommendation and the route without asking for a click', () => {
    const markup = html();
    const disclosure = markup.indexOf('<details');

    expect(disclosure).toBeGreaterThan(-1);
    for (const ahead of ['One serverless warehouse per team', 'Attribute the current spend before changing anything']) {
      // Asserted present as well as ordered: absent text answers -1, which is before everything.
      expect(markup).toContain(ahead);
      expect(markup.indexOf(ahead)).toBeLessThan(disclosure);
    }
  });

  it('numbers the route, because the stages are in an order and the first one is the skipped one', () => {
    expect(html()).toContain('<ol');
  });

  it('puts the trade-offs behind the disclosure, under a heading of their own', () => {
    const markup = html();

    expect(markup).toContain('What it costs');
    expect(markup.indexOf('Serverless bills at a higher rate')).toBeGreaterThan(markup.indexOf('<details'));
  });

  it('renders what to keep and when to look again, which nothing else on a finding says', () => {
    const markup = html();

    expect(markup).toContain('A dated breakdown of DBUs by billing origin product');
    expect(markup).toContain('the all-purpose share rising two months running');
  });

  it('takes its heading from the caller, because the finding and the question ask different things', () => {
    expect(html()).toContain('Where to get to');
    expect(
      renderToStaticMarkup(<GuidanceAdvicePanel advice={ADVICE} label="If you want to change the answer" />)
    ).toContain('If you want to change the answer');
  });
});
