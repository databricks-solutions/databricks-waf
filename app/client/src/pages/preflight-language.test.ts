import { describe, expect, it } from 'vitest';
import type { Preflight } from '@/api/types';
import { describeFreshness, describeOmission, describeReading, remediesFor, unfixable } from './preflight-language';

const NOW = new Date('2026-08-03T12:00:00Z');

function preflight(over: Partial<Preflight> = {}): Preflight {
  return {
    ranAt: NOW.toISOString(),
    ranAs: 'alice@example.com',
    definitionId: 'd1',
    version: 1,
    fingerprint: 'sha256:abc',
    sources: [],
    blocked: [],
    ready: 0,
    verdict: 'A verdict.',
    ...over,
  };
}

describe('remediesFor', () => {
  /*
   * The grouping is the design. Two denied tables in one schema are one request, and a page that
   * listed them separately would make a one-line ask look like two.
   */
  it('is one ask per grant, however many tables sit behind it', () => {
    const grant = 'GRANT SELECT ON SCHEMA system.billing TO `alice@example.com`';
    const remedies = remediesFor(
      preflight({
        sources: [
          { table: 'system.billing.usage', schema: 'system.billing', reading: 'denied', detail: 'no', grant, blocks: ['A'] },
          { table: 'system.billing.list_prices', schema: 'system.billing', reading: 'denied', detail: 'no', grant, blocks: ['B'] },
        ],
        blocked: [
          { controlId: 'A', pillarId: 'p', needs: [grant] },
          { controlId: 'B', pillarId: 'p', needs: [grant] },
        ],
      }),
    );

    expect(remedies).toHaveLength(1);
    expect(remedies[0]?.tables).toEqual(['system.billing.list_prices', 'system.billing.usage']);
    expect(remedies[0]?.checks).toBe(2);
  });

  it('puts the grant that unblocks the most first, since that is the one to chase', () => {
    const billing = 'GRANT SELECT ON SCHEMA system.billing TO `alice@example.com`';
    const access = 'GRANT SELECT ON SCHEMA system.access TO `alice@example.com`';
    const remedies = remediesFor(
      preflight({
        sources: [
          { table: 'system.access.audit', schema: 'system.access', reading: 'denied', detail: 'no', grant: access, blocks: ['A'] },
          {
            table: 'system.billing.usage',
            schema: 'system.billing',
            reading: 'denied',
            detail: 'no',
            grant: billing,
            blocks: ['B', 'C'],
          },
        ],
        blocked: [
          { controlId: 'A', pillarId: 'p', needs: [access] },
          { controlId: 'B', pillarId: 'p', needs: [billing] },
          { controlId: 'C', pillarId: 'p', needs: [billing] },
        ],
      }),
    );

    expect(remedies.map((remedy) => remedy.checks)).toEqual([2, 1]);
    expect(remedies[0]?.grant).toBe(billing);
  });

  /*
   * `blocks` is every check that reads the table, blocked or not. Counting it directly would credit a
   * grant with checks that were never stopped, which overstates what the ask buys — and a reader who
   * makes the grant and gets fewer checks than promised has learnt to discount the next number.
   */
  it('counts only the checks the denial actually stopped', () => {
    const grant = 'GRANT SELECT ON SCHEMA system.billing TO `alice@example.com`';
    const remedies = remediesFor(
      preflight({
        sources: [
          {
            table: 'system.billing.usage',
            schema: 'system.billing',
            reading: 'denied',
            detail: 'no',
            grant,
            blocks: ['A', 'B'],
          },
        ],
        blocked: [{ controlId: 'A', pillarId: 'p', needs: [grant] }],
      }),
    );

    expect(remedies[0]?.checks).toBe(1);
  });

  it('offers nothing to ask for when nothing was refused', () => {
    expect(
      remediesFor(
        preflight({
          sources: [
            { table: 'system.billing.usage', schema: 'system.billing', reading: 'readable', detail: 'ok', blocks: ['A'] },
          ],
        }),
      ),
    ).toEqual([]);
  });
});

describe('unfixable', () => {
  it('separates the failures a grant will not fix', () => {
    const result = unfixable(
      preflight({
        sources: [
          { table: 'a.b.c', schema: 'a.b', reading: 'readable', detail: 'ok', blocks: [] },
          { table: 'a.b.d', schema: 'a.b', reading: 'denied', detail: 'no', grant: 'g', blocks: [] },
          { table: 'a.b.e', schema: 'a.b', reading: 'absent', detail: 'gone', blocks: [] },
          { table: 'a.b.f', schema: 'a.b', reading: 'unknown', detail: '503', blocks: [] },
        ],
      }),
    );

    expect(result.map((source) => source.table)).toEqual(['a.b.e', 'a.b.f']);
  });
});

describe('describeReading', () => {
  it('says what to do rather than restating the status', () => {
    expect(describeReading({ table: 'a.b.c', schema: 'a.b', reading: 'absent', detail: '', blocks: [] })).toContain(
      'enabled',
    );
    expect(describeReading({ table: 'a.b.c', schema: 'a.b', reading: 'unknown', detail: '', blocks: [] })).toContain(
      'no remedy',
    );
  });
});

describe('a denial with no grant to offer', () => {
  /*
   * The server declines to write a grant for an identity it cannot quote as one SQL token. Such a
   * source is in neither the remedies nor the absent-and-unknown set, so without this it appears
   * nowhere but the disclosure — and the verdict's count of blocked checks exceeds anything the page
   * accounted for, which reads as the page having lost one.
   */
  it('is still presented, rather than falling between the two lists', () => {
    const subject = preflight({
      sources: [
        { table: 'system.billing.usage', schema: 'system.billing', reading: 'denied', detail: 'PERMISSION_DENIED', blocks: ['CO-01-01'] },
      ],
      blocked: [{ controlId: 'CO-01-01', pillarId: 'cost-optimization', needs: [] }],
    });

    const [stuck] = unfixable(subject);
    expect(remediesFor(subject)).toEqual([]);
    expect(unfixable(subject).map((source) => source.table)).toEqual(['system.billing.usage']);
    expect(stuck && describeReading(stuck)).toContain('will not write out');
  });

  it('reads as a plain refusal when there is a grant beside it', () => {
    expect(
      describeReading({
        table: 'system.billing.usage',
        schema: 'system.billing',
        reading: 'denied',
        detail: 'PERMISSION_DENIED',
        blocks: [],
        grant: 'GRANT SELECT ON SCHEMA system.billing TO `alice@example.com`',
      }),
    ).toBe('Refused for want of a grant.');
  });
});

describe('describeOmission', () => {
  it('distinguishes a workspace with nothing to read from one that has gone missing', () => {
    expect(describeOmission('not-running')).toContain('nothing to read');
    expect(describeOmission('other-region')).toContain('cannot reach');
    // The only one of the three that is a gap rather than a state, and the only one worth chasing.
    expect(describeOmission('unknown')).toContain('deleted or renamed');
  });
});

describe('describeFreshness', () => {
  /*
   * One date for two things of different ages is the failure this sentence prevents. The grants were
   * checked seconds ago; the estate they were held against may be a month old, and a reader told only
   * "checked just now" would act on the older half believing it was current.
   */
  it('dates the probe and the estate separately', () => {
    const said = describeFreshness(
      preflight({ scopeAsOf: new Date('2026-07-20T00:00:00Z').toISOString() }),
      NOW,
    );

    expect(said).toContain('Grants checked today');
    expect(said).toContain('14 days ago');
    expect(said).toContain('alice@example.com');
  });

  /*
   * The verdict above the line already says the scope is unresolved and why. Saying it again here put
   * the same fact in two adjacent sentences, which reads as two findings.
   */
  it('gives one date when there is only one, rather than restating the verdict', () => {
    const said = describeFreshness(preflight(), NOW);

    expect(said).toBe('Grants checked today, as alice@example.com.');
    expect(said, 'an unresolved estate must not be dated as though it were read').not.toContain('read today');
  });
});
