// What the strip says, and the three things it must not say.
//
// The counts are the easy half. The half worth a test is the same one `change-language.test.ts`
// exists for: every claim this strip could make wrongly reads as reassurance. Four zeros over an
// estate half of which was carried forward. A refusal rendered as nothing having moved. A
// requirement the catalogue only just started asking, counted as one the estate stopped meeting.

import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { classOf, countChanges } from '../change-language';
import type { ControlChange, RunChanges, Scan } from '../../api/types';

const changes = vi.hoisted(() => ({ current: undefined as RunChanges | undefined, loading: false }));
const assessment = vi.hoisted((): { scanId: string | undefined; resultId: string | undefined } => ({
  scanId: 'run-2',
  resultId: 'result-2',
}));

vi.mock('../../api/hooks', () => ({
  useRunChanges: () => ({ data: changes.current, loading: changes.loading }),
  useResultChanges: () => ({ data: changes.current, loading: changes.loading }),
  useResult: () => ({ loading: false }),
}));

vi.mock('../../api/assessment-context', () => ({
  useAssessment: () => ({
    scan: assessment.scanId == null ? undefined : ({ id: assessment.scanId } as Scan),
    result: assessment.resultId == null ? undefined : { id: assessment.resultId },
  }),
}));

const { DifferentialStrip } = await import('./DifferentialStrip');

function change(from: ControlChange['from'], to: ControlChange['to'], id = `${from}-${to}`): ControlChange {
  return { controlId: id, title: id, pillarId: 'reliability', severity: 'high', from, to };
}

function text(markup: string): string {
  return markup.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
}

/**
 * The hrefs, as a browser would resolve them rather than as the markup spells them.
 *
 * `renderToStaticMarkup` writes `&` as `&amp;`, so asserting on the raw string means writing the
 * entity into this file — and `check:routes` reads the file, finds a link to a `amp;changed`
 * parameter no page reads, and fails a route that is correct.
 */
function links(markup: string): readonly string[] {
  return [...markup.matchAll(/href="([^"]+)"/g)].map((found) => found[1].replaceAll('&amp;', '&'));
}

function strip(over: Partial<RunChanges> = {}, at = '/findings'): string {
  changes.current = { comparable: true, changes: [], unobserved: [], ...over };
  changes.loading = false;
  const router = createMemoryRouter([{ path: '*', element: <DifferentialStrip /> }], { initialEntries: [at] });
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe('how a transition is classed', () => {
  it('does not call a requirement the previous run had no outcome for a regression', () => {
    // The estate did not stop meeting something nobody asked it. Counting this as a regression is
    // the catalogue gaining a question and the customer being told their platform got worse.
    expect(classOf(change('absent', 'fail'))).toBe('new');
    expect(classOf(change('pass', 'fail'))).toBe('regressed');
  });

  it('reads a withdrawal as changed rather than resolved, since nothing was met', () => {
    expect(classOf(change('fail', 'absent'))).toBe('changed');
  });

  it('counts each transition once, so the four add up to the whole comparison', () => {
    const all = [
      change('absent', 'pass'),
      change('pass', 'fail'),
      change('fail', 'pass'),
      // Neither side unmet, so neither a regression nor a resolution: the estate stopped being
      // readable on a requirement it was passing.
      change('pass', 'unmeasurable'),
    ];
    const counted = countChanges(all);

    expect(counted).toEqual({ new: 1, regressed: 1, resolved: 1, changed: 1 });
    expect(counted.new + counted.regressed + counted.resolved + counted.changed).toBe(all.length);
  });
});

describe('the strip', () => {
  it('says what was carried forward, so four zeros are not read as a quiet week', () => {
    const said = strip({ unobserved: ['reliability', 'security'] });

    expect(text(said)).toContain('2 pillars were carried forward rather than measured');
    expect(said).toContain('the counts are over the rest');
  });

  it('leaves that sentence out when everything was measured', () => {
    expect(strip({ changes: [change('pass', 'fail')] })).not.toContain('carried forward');
  });

  it('gives the refusal rather than going quiet, which would read as nothing having moved', () => {
    const said = strip({ comparable: false, reason: 'These runs were measured as different identities.' });

    expect(text(said)).toContain('These runs were measured as different identities.');
    expect(text(said)).not.toContain('0 regressed');
  });

  it('links a count to the rows it counted, and does not link a zero to nothing', () => {
    const said = strip({ changes: [change('pass', 'fail')] });

    expect(links(said)).toContain('/investigate?changed=regressed');
    expect(links(said).join(' ')).not.toContain('changed=resolved');
    expect(text(said)).toContain('0 resolved');
  });

  it('is about the run in view where a route names one, rather than about the newest', () => {
    const said = strip({ changes: [change('pass', 'fail')] }, '/history/run-1');

    expect(links(said).join(' ')).toContain('/history/run-1?view=changes');
    expect(links(said).join(' ')).not.toContain('/history/run-2');
  });

  it('renders nothing at all when no run has been recorded', () => {
    assessment.scanId = undefined;
    assessment.resultId = undefined;
    expect(strip()).toBe('');
    assessment.scanId = 'run-2';
    assessment.resultId = 'result-2';
  });
});
