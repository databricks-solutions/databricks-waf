// The guidance panel, asserted on the HTML it emits.
//
// Three properties are worth pinning, and each of them is a decision that a later reader tidying the
// layout would undo without noticing.
//
// The rubric and the middle answer are visible without a click, because a reader who has to open a
// disclosure to find out what "partially" means will not open it. The examples are behind one,
// because three worked answers above a form push the form off a laptop screen. And a reference is
// rendered as its page rather than its URL, because a docs URL is ninety characters in a 380px pane.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GuidancePanel } from './AnswerGuidance';
import type { Guidance } from '../api/types';

const GUIDANCE: Guidance = {
  means: 'Changes to production reach it through a pipeline rather than a person.',
  matters: 'A change nobody can reproduce is a change nobody can roll back.',
  good: ['Deployment is a pipeline run', 'The pipeline runs tests before it promotes'],
  examples: {
    strong: 'Every workspace is deployed from bundles in CI.',
    partial: 'Two of six workspaces deploy from CI; the rest are notebooks.',
    weak: 'Notebooks are edited in production.',
  },
  verify: [{ how: 'ui', where: 'Workflows, the job that deploys', expect: 'a git source rather than a workspace path' }],
  pitfalls: ['A pipeline that exists but is bypassed under pressure'],
  partialWhen: 'Some estates deploy this way and others do not.',
  ownerRole: 'Platform engineering',
  lastReviewed: '2026-08-01',
  references: ['https://docs.databricks.com/dev-tools/bundles/index.html'],
};

const html = (guidance: Guidance): string => renderToStaticMarkup(<GuidancePanel guidance={guidance} />);

describe('the answering guidance', () => {
  it('shows the rubric and the middle answer without asking for a click', () => {
    const markup = html(GUIDANCE);
    const disclosure = markup.indexOf('<details');

    expect(disclosure).toBeGreaterThan(-1);
    // Ordered against the disclosure and asserted present, in that order. Absent text answers -1 to
    // `indexOf`, which is less than every real position, so "before the disclosure" is otherwise
    // satisfied by not rendering at all.
    for (const ahead of ['The pipeline runs tests before it promotes', 'Some estates deploy this way']) {
      expect(markup).toContain(ahead);
      expect(markup.indexOf(ahead)).toBeLessThan(disclosure);
    }
  });

  it('keeps the three worked examples behind the disclosure', () => {
    // Not a tidiness preference. The pane this sits in carries the answer form, and a reader who has
    // to scroll past three example answers to reach the field answers from memory of the examples.
    const markup = html(GUIDANCE);
    const disclosure = markup.indexOf('<details');

    expect(markup.indexOf('Two of six workspaces deploy from CI')).toBeGreaterThan(disclosure);
    expect(markup.indexOf('bypassed under pressure')).toBeGreaterThan(disclosure);
    expect(markup.indexOf('Workflows, the job that deploys')).toBeGreaterThan(disclosure);
  });

  it('renders what a check cannot establish, on its own line', () => {
    // The reason this field exists at all. A review of the first authored pillars found checks that
    // query a table structurally excluding the population being asked about — `system.query.history`
    // holds nothing from classic compute — so the estate that fails hardest returns no rows and reads
    // as exemplary. Rendering it as the tail of the expectation is how it got missed the first time.
    const markup = html({
      ...GUIDANCE,
      verify: [
        {
          how: 'sql',
          where: 'select count(*) from system.query.history',
          expect: 'no spill',
          caveat: 'Nothing from classic job compute appears here, so a clean result may mean no evidence.',
        },
      ],
    });

    const expectation = markup.indexOf('Expect no spill');
    const caveat = markup.indexOf('Nothing from classic job compute appears here');

    // Asserted present before being ordered. `indexOf` answers -1 for absent, so comparing two
    // positions passes whenever the first is missing — which is the shape of false pass this whole
    // field exists to stop, and it does not stop being one inside a test.
    expect(expectation).toBeGreaterThan(-1);
    expect(caveat).toBeGreaterThan(-1);
    // Outside the expectation's own run of text, so skimming to the end of it cannot skip the caveat.
    expect(expectation).toBeLessThan(caveat);
    expect(markup).toContain('But:');
  });

  it('says nothing where a check has no caveat', () => {
    expect(html(GUIDANCE)).not.toContain('But:');
  });

  it('names a reference by its page rather than printing the URL', () => {
    // `index.html` names the directory it sits in, so the page is the segment before it. Docs URLs
    // end that way often enough that taking the last segment blindly labels three links index.html.
    const markup = html(GUIDANCE);
    expect(markup).toContain('docs.databricks.com — bundles');
    expect(markup).toContain('href="https://docs.databricks.com/dev-tools/bundles/index.html"');

    const trailing = html({ ...GUIDANCE, references: ['https://docs.databricks.com/aws/en/ldp/expectations'] });
    expect(trailing).toContain('docs.databricks.com — expectations');
  });

  it('leaves out the optional fields rather than heading an empty one', () => {
    // `not_applicable_when` is absent on most entries because most requirements always apply, and a
    // heading with nothing under it reads as content that failed to load.
    const markup = html({
      means: GUIDANCE.means,
      matters: GUIDANCE.matters,
      good: GUIDANCE.good,
      examples: GUIDANCE.examples,
      verify: GUIDANCE.verify,
      pitfalls: GUIDANCE.pitfalls,
      partialWhen: GUIDANCE.partialWhen,
      references: [],
    });

    expect(markup).not.toContain('When it does not apply');
    expect(markup).not.toContain('Usually answered by');
    expect(markup).not.toContain('Reviewed');
    expect(markup).not.toContain('Read further');
    // Asserted so the test cannot pass by rendering nothing at all.
    expect(markup).toContain('What good looks like');
  });
});
