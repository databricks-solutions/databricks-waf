// The preflight report, asserted on the HTML it emits.
//
// Two properties here were wrong in a first draft and both were only visible on screen, which is the
// argument for pinning them.
//
// The scope is stated once. The verdict is assembled server-side and ends with the coverage sentence,
// so a panel that also rendered `scope.description` printed the same claim twice in adjacent lines —
// and a reader takes two statements of one fact as two findings. What this renders instead is the
// list of workspaces, which is the part the verdict cannot carry: "two of five" is only actionable
// once you know which three are missing.
//
// The grants come before the sources. A reader of this panel is deciding whether to press Run, and
// what they need is the line to send a metastore admin — not twenty-eight rows of `readable` to
// scroll past first.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PreflightReport } from './PreflightReport';
import type { Preflight } from '../api/types';

const RAN_AT = new Date('2026-08-03T12:00:00Z').toISOString();

function preflight(over: Partial<Preflight> = {}): Preflight {
  return {
    ranAt: RAN_AT,
    ranAs: 'alice@example.com',
    definitionId: 'd1',
    version: 1,
    fingerprint: 'sha256:abc',
    ready: 9,
    verdict: 'A verdict, ending with the coverage. Two of five workspaces are outside what this run can reach.',
    blocked: [
      {
        controlId: 'CO-01-01',
        pillarId: 'cost-optimization',
        needs: ['GRANT SELECT ON SCHEMA system.billing TO `alice@example.com`'],
      },
    ],
    sources: [
      {
        table: 'system.billing.usage',
        schema: 'system.billing',
        reading: 'denied',
        detail: 'PERMISSION_DENIED: SQLSTATE 42501',
        blocks: ['CO-01-01'],
        grant: 'GRANT SELECT ON SCHEMA system.billing TO `alice@example.com`',
      },
      {
        table: 'system.compute.clusters',
        schema: 'system.compute',
        reading: 'readable',
        detail: 'The read was allowed.',
        blocks: [],
      },
    ],
    ...over,
  };
}

const SCOPE: NonNullable<Preflight['scope']> = {
  assessed: ['1', '3'],
  omitted: [
    { workspaceId: '2', name: 'old-eu', reason: 'other-region' },
    { workspaceId: '9', reason: 'unknown' },
  ],
  outOfScope: 0,
  complete: false,
  description: 'Two of five workspaces are outside what this run can reach.',
};

describe('PreflightReport', () => {
  it('states the coverage once, and names the workspaces the verdict cannot', () => {
    const html = renderToStaticMarkup(
      <PreflightReport preflight={preflight({ scope: SCOPE, scopeAsOf: RAN_AT })} />,
    );

    const claim = 'Two of five workspaces are outside what this run can reach';
    expect(html.indexOf(claim), 'the verdict states the coverage').toBeGreaterThan(-1);
    expect(html.indexOf(claim, html.indexOf(claim) + 1), 'and nothing states it again').toBe(-1);

    // What the sentence leaves out: which ones, and why each.
    expect(html).toContain('old-eu');
    expect(html).toContain('another region');
    // No name in the directory, so the id has to stand in rather than the row going missing.
    expect(html).toContain('>9<');
    expect(html).toContain('deleted or renamed');
  });

  it('says nothing about coverage when every workspace in scope is assessable', () => {
    const html = renderToStaticMarkup(
      <PreflightReport
        preflight={preflight({
          scope: { assessed: ['1'], omitted: [], outOfScope: 0, complete: true, description: '' },
          scopeAsOf: RAN_AT,
        })}
      />,
    );

    expect(html).not.toContain('Not covered');
  });

  it('puts the grant to ask for above the evidence for it', () => {
    const html = renderToStaticMarkup(<PreflightReport preflight={preflight()} />);

    const ask = html.indexOf('What to ask for');
    const evidence = html.indexOf('Every source this assessment reads');
    expect(ask).toBeGreaterThan(-1);
    expect(evidence).toBeGreaterThan(ask);
  });

  it('counts what a grant buys against every check in the assessment, not only the blocked ones', () => {
    // `ready` is 9 and one check is blocked, so the denominator is 10. Counting against the blocked
    // set alone would render "1 of 1" and read as though the grant fixed everything.
    const html = renderToStaticMarkup(<PreflightReport preflight={preflight()} />);

    expect(html).toContain('of 10');
  });

  it('offers no grant for a source a grant will not fix', () => {
    const html = renderToStaticMarkup(
      <PreflightReport
        preflight={preflight({
          blocked: [{ controlId: 'REL-03-01', pillarId: 'reliability', needs: [] }],
          sources: [
            {
              table: 'system.lakeflow.pipeline_update_timeline',
              schema: 'system.lakeflow',
              reading: 'absent',
              detail: 'TABLE_OR_VIEW_NOT_FOUND',
              blocks: ['REL-03-01'],
            },
          ],
        })}
      />,
    );

    expect(html).not.toContain('What to ask for');
    expect(html).toContain('Blocked, with no statement to run');
    // The platform's own words, so a reader can search for them.
    expect(html).toContain('TABLE_OR_VIEW_NOT_FOUND');
  });
});
