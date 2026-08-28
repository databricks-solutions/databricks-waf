// The reference that travels from a finding to the form, and what it may say on the way.
//
// Two things are checked here and the second is the one worth the file. The round trip is ordinary. The
// refusals are not: a partial reference names a set of findings rather than one, and a page that
// offered to raise work from it would be offering something the server refuses after the reader has
// filled in a form.

import { describe, expect, it } from 'vitest';
import { adviceHref, adviceIn, advicePhrase } from './advice-link';

const REFERENCE = {
  advisoryId: 'adv-1',
  advisor: 'sizing' as const,
  resource: 'wh-1',
  rule: 'WAREHOUSE_QUEUEING',
};

/** What a URL built by `adviceHref` reads as when the page it points at parses it. */
function roundTrip(href: string) {
  return adviceIn(new URLSearchParams(href.slice(href.indexOf('?'))));
}

describe('carrying a finding to the page that raises work from it', () => {
  it('comes back as what went in', () => {
    expect(roundTrip(adviceHref('/improvements', REFERENCE))).toEqual(REFERENCE);
  });

  it('keeps the path it was given, so the same reference works on a plan as on the list', () => {
    expect(adviceHref('/improvements/plan-1', REFERENCE).startsWith('/improvements/plan-1?')).toBe(true);
  });

  it('escapes a resource that is not URL-safe, which a job name-shaped id can be', () => {
    const odd = { ...REFERENCE, resource: 'wh 1&rule=OTHER' };

    expect(roundTrip(adviceHref('/improvements', odd))).toEqual(odd);
  });
});

describe('a URL carrying less than a whole reference', () => {
  it.each(['advisory', 'advisor', 'resource', 'rule'])('is nothing at all without %s', (missing) => {
    const params = new URLSearchParams(adviceHref('/improvements', REFERENCE).split('?')[1]);
    params.delete(missing);

    expect(adviceIn(params)).toBeUndefined();
  });

  it('is nothing where a parameter is present and empty', () => {
    const params = new URLSearchParams({ advisory: 'adv-1', advisor: 'sizing', resource: '', rule: 'R' });

    expect(adviceIn(params)).toBeUndefined();
  });

  it('is nothing where the advisor is not one of the four this app has', () => {
    // A hand-edited URL, or a link from a build that had a fifth advisor. Either way the server would
    // refuse it, and refusing it here is the difference between a link that does nothing and a form
    // that fails on submission.
    const params = new URLSearchParams({ advisory: 'adv-1', advisor: 'clusters', resource: 'c-1', rule: 'R' });

    expect(adviceIn(params)).toBeUndefined();
  });

  it('carries nothing on a page nobody arrived at from a finding', () => {
    expect(adviceIn(new URLSearchParams('?action=id-2'))).toBeUndefined();
  });
});

describe('what the pages say they are raising work from', () => {
  it('names the advisor, the rule and the thing it fired on', () => {
    const phrase = advicePhrase(REFERENCE);

    expect(phrase).toContain('warehouse sizing');
    expect(phrase).toContain('WAREHOUSE_QUEUEING');
    expect(phrase).toContain('wh-1');
  });

  it('calls the thing what that advisor found it on, rather than "resource"', () => {
    expect(advicePhrase({ ...REFERENCE, advisor: 'workload', resource: 'abc0' })).toContain('query group abc0');
    expect(advicePhrase({ ...REFERENCE, advisor: 'jobs', resource: '881' })).toContain('job 881');
  });

  it('quotes nothing the advisor said, because these pages have not read the advisory', () => {
    // The whole of why the reference is four ids. A headline in the query string would be a sentence
    // attributed to the advisor that came out of a URL somebody could edit; the words on the action
    // are read from the stored advisory by the server, when the action is written.
    expect(advicePhrase(REFERENCE)).toBe("the warehouse sizing advisor's WAREHOUSE_QUEUEING finding on warehouse wh-1");
  });
});
