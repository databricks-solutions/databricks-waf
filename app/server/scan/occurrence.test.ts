// How long a requirement has held its outcome.
//
// A streak is a claim, and the claim is wrong in a specific and expensive way: "failing for six
// runs" told to somebody whose catalogue changed, or whose scans ran as two different identities,
// is a statement about the estate assembled out of answers to different questions. So most of what
// is asserted below is about where the walk stops rather than about how far it gets.

import { describe, expect, it } from 'vitest';
import type { CatalogueChange, CatalogueChangelog } from '../catalogue/changelog.js';
import { occurrenceOf, occurrencesIn } from './occurrence.js';
import type { Scan, ScanStamp } from './scan.js';
import { summarise } from './store.js';
import type { ScanSummary } from './store.js';
import type { Finding, Outcome } from '../resolve/finding.js';
import { CollectionScheduler } from './scheduler.js';

function stamp(one: Partial<ScanStamp> = {}): ScanStamp {
  return {
    publicMethodology: { publicVersion: 1, manifestDigest: 'sha256:manifest', state: 'released' },
    catalogueVersion: '9',
    catalogueFingerprint: 'nine',
    executionMode: 'on-behalf-of-user',
    actor: 'dana@example.com',
    scope: { description: 'the whole account' },
    lookbackDays: 30,
    ...one,
  };
}

function identity(methodology: string): NonNullable<ScanStamp['identity']> {
  return {
    build: { id: 'v2' },
    methodology: { id: methodology },
    record: { id: '3' },
    sources: ['sql'],
  };
}

function finding(controlId: string, outcome: Outcome): Finding {
  return {
    controlId,
    pillarId: 'reliability',
    principleId: 'rel-1',
    title: controlId,
    outcome,
    severity: 'high',
    coverage: { mode: 'complete' },
    evidence: [],
  };
}

function scan(one: Partial<Scan> = {}): Scan {
  return {
    id: 'now',
    state: 'complete',
    startedAt: new Date('2026-08-03T09:00:00.000Z'),
    finishedAt: new Date('2026-08-03T09:05:00.000Z'),
    stamp: stamp(),
    findings: [finding('REL-01-01', 'fail')],
    signals: [],
    score: { overall: 50, pillars: [], composition: { observed: 1, adminCollected: 0, attested: 0 } },
    measurement: [],
    scheduler: new CollectionScheduler(),
    ...one,
  } as Scan;
}

/** An earlier run, summarised the way the store would have summarised it. */
function earlier(id: string, day: number, outcomes: Record<string, Outcome>, one: Partial<ScanStamp> = {}): ScanSummary {
  const at = new Date(`2026-07-${String(day).padStart(2, '0')}T09:00:00.000Z`);
  return summarise(
    scan({
      id,
      startedAt: at,
      finishedAt: at,
      stamp: stamp(one),
      findings: Object.entries(outcomes).map(([controlId, outcome]) => finding(controlId, outcome)),
    })
  );
}

describe('how long a requirement has held its outcome', () => {
  it('counts consecutive runs that reached the same outcome, back to the first', () => {
    const history = [earlier('b', 25, { 'REL-01-01': 'fail' }), earlier('a', 18, { 'REL-01-01': 'fail' })];

    const occurrence = occurrenceOf('REL-01-01', scan(), history);

    expect(occurrence.runs).toBe(3);
    expect(occurrence.since).toEqual(new Date('2026-07-18T09:00:00.000Z'));
  });

  it('stops at the run where the outcome was different, and says what it was', () => {
    const history = [earlier('b', 25, { 'REL-01-01': 'fail' }), earlier('a', 18, { 'REL-01-01': 'pass' })];

    const occurrence = occurrenceOf('REL-01-01', scan(), history);

    expect(occurrence.runs).toBe(2);
    expect(occurrence.horizon).toBe('changed');
    expect(occurrence.changedFrom).toEqual({ outcome: 'pass', at: new Date('2026-07-18T09:00:00.000Z') });
  });

  it('refuses to walk past a run it cannot compare to, and says so', () => {
    // A different catalogue asked a different question, so the answers are not a streak.
    const history = [
      earlier('b', 25, { 'REL-01-01': 'fail' }),
      earlier('a', 18, { 'REL-01-01': 'fail' }, { catalogueVersion: '8', catalogueFingerprint: 'eight' }),
    ];

    const occurrence = occurrenceOf('REL-01-01', scan(), history);

    expect(occurrence.runs).toBe(2);
    expect(occurrence.horizon).toBe('not-comparable');
    expect(occurrence.changedFrom).toBeUndefined();
  });

  it('refuses to walk past a run by a different identity', () => {
    const history = [earlier('a', 25, { 'REL-01-01': 'fail' }, { actor: 'someone-else@example.com' })];

    expect(occurrenceOf('REL-01-01', scan(), history).horizon).toBe('not-comparable');
  });

  it('uses the same rule as every other comparison rather than one of its own', () => {
    // The narrower rule this was tempted by reads the flat summary fields, which hold no
    // methodology digest — so it would have walked straight through a change of weighting.
    const history = [earlier('a', 25, { 'REL-01-01': 'fail' }, { identity: identity('different') })];
    const now = scan({ stamp: stamp({ identity: identity('original') }) });

    expect(occurrenceOf('REL-01-01', now, history).horizon).toBe('not-comparable');
  });

  it('does not walk past a stamp too damaged to compare against', () => {
    // The summary comes back out of a jsonb column, so a truncated one is a read rather than a
    // type error — and a crash here would take out the finding pane, not just its history.
    const damaged = { ...earlier('a', 25, { 'REL-01-01': 'fail' }), stamp: { catalogueVersion: '9' } as ScanStamp };

    expect(occurrenceOf('REL-01-01', scan(), [damaged]).horizon).toBe('unrecorded');
  });

  describe('a catalogue release the two runs straddle', () => {
    /** A recorded release from version 8 to 9, which is what the fixtures' two versions are. */
    function released(one: Partial<CatalogueChange> = {}): CatalogueChangelog {
      return {
        entries: [
          {
            version: '9',
            fingerprint: 'nine',
            recordedAt: '2026-07-20',
            scoredUnits: 2,
            describes: true,
            added: [],
            removed: [],
            renamed: [],
            changed: [],
            ...one,
          },
        ],
      };
    }

    const earlierVersion = { catalogueVersion: '8', catalogueFingerprint: 'eight' };

    it('carries the streak through, for a requirement the release left alone', () => {
      // The point of recording a release: most of two catalogues is the same catalogue, so a
      // requirement nothing in the release touched was asked identically either side of it. Stopping
      // for every requirement gave back with one hand what the changelog took with the other.
      const history = [
        earlier('b', 25, { 'REL-01-01': 'fail' }),
        earlier('a', 18, { 'REL-01-01': 'fail' }, earlierVersion),
      ];

      const occurrence = occurrenceOf('REL-01-01', scan(), history, released({ added: ['NEW-01-01'] }));

      expect(occurrence.runs).toBe(3);
      expect(occurrence.horizon).not.toBe('not-comparable');
    });

    it('stops where the release changed what this requirement asks', () => {
      const history = [earlier('a', 25, { 'REL-01-01': 'fail' }, earlierVersion)];

      const occurrence = occurrenceOf(
        'REL-01-01',
        scan(),
        history,
        released({ changed: [{ id: 'REL-01-01', fields: ['severity'] }] })
      );

      expect(occurrence.runs).toBe(1);
      expect(occurrence.horizon).toBe('redefined');
    });

    it('stops where the release introduced this requirement', () => {
      const history = [earlier('a', 25, { 'OTHER-01-01': 'pass' }, earlierVersion)];

      const occurrence = occurrenceOf('REL-01-01', scan(), history, released({ added: ['REL-01-01'] }));

      expect(occurrence.runs).toBe(1);
      expect(occurrence.horizon).toBe('introduced');
    });

    it('follows a renumbering, so the streak is the requirement rather than the number', () => {
      // A renumbered requirement is the same question with a different label, which is what
      // `continues` declares. The earlier run recorded it under the number it used then.
      const history = [earlier('a', 25, { 'REL-09-09': 'fail' }, earlierVersion)];

      const occurrence = occurrenceOf(
        'REL-01-01',
        scan(),
        history,
        released({ renamed: [{ from: 'REL-09-09', to: 'REL-01-01' }] })
      );

      expect(occurrence.runs).toBe(2);
      expect(occurrence.since).toEqual(new Date('2026-07-25T09:00:00.000Z'));
    });

    it('still refuses the whole walk when the release itself was never recorded', () => {
      // No entry for version 9 means nothing is known about what it did, and a streak through an
      // undescribed release is the claim this module exists not to make.
      const history = [earlier('a', 25, { 'REL-01-01': 'fail' }, earlierVersion)];

      expect(occurrenceOf('REL-01-01', scan(), history).horizon).toBe('not-comparable');
    });
  });

  it('stops at a run recorded before per-requirement outcomes were kept', () => {
    const { outcomes: _dropped, ...withoutOutcomes } = earlier('a', 25, { 'REL-01-01': 'fail' });

    const occurrence = occurrenceOf('REL-01-01', scan(), [withoutOutcomes]);

    expect(occurrence.runs).toBe(1);
    expect(occurrence.horizon).toBe('unrecorded');
  });

  it('stops at a run recorded before the stamp was kept, rather than comparing against nothing', () => {
    const { stamp: _dropped, ...withoutStamp } = earlier('a', 25, { 'REL-01-01': 'fail' });

    expect(occurrenceOf('REL-01-01', scan(), [withoutStamp]).horizon).toBe('unrecorded');
  });

  it('does not report a requirement the earlier run never held as an outcome that changed', () => {
    // The catalogue gained it. Saying "it used to be absent" invites reading a change of question
    // as the estate losing something.
    const history = [earlier('a', 25, { 'REL-02-02': 'pass' })];

    const occurrence = occurrenceOf('REL-01-01', scan(), history);

    expect(occurrence.horizon).toBe('unrecorded');
    expect(occurrence.changedFrom).toBeUndefined();
  });

  it('calls the estate\u2019s only run a first run rather than a truncated history', () => {
    expect(occurrenceOf('REL-01-01', scan(), []).horizon).toBe('first-run');
  });

  it('does not claim a page boundary is the beginning of the record', () => {
    // Walking every summary it was handed says nothing about whether more exist behind them.
    const history = [earlier('b', 25, { 'REL-01-01': 'fail' }), earlier('a', 18, { 'REL-01-01': 'fail' })];

    expect(occurrenceOf('REL-01-01', scan(), history).horizon).toBe('retention');
  });

  it('skips the run in hand when the history already holds it', () => {
    const now = scan();
    const history = [summarise(now), earlier('b', 25, { 'REL-01-01': 'fail' })];

    // Two runs, not three: the current run appears once whether or not it has been written.
    expect(occurrenceOf('REL-01-01', now, history).runs).toBe(2);
  });

  it('reports one run for a requirement this scan has no finding for', () => {
    expect(occurrenceOf('NOT-A-CONTROL', scan(), []).runs).toBe(1);
  });

  it('answers for every requirement in the run at once', () => {
    const now = scan({ findings: [finding('REL-01-01', 'fail'), finding('REL-02-02', 'pass')] });
    const history = [earlier('a', 25, { 'REL-01-01': 'fail', 'REL-02-02': 'fail' })];

    const all = occurrencesIn(now, history);

    expect(all.get('REL-01-01')?.runs).toBe(2);
    expect(all.get('REL-02-02')?.runs).toBe(1);
    expect(all.get('REL-02-02')?.changedFrom?.outcome).toBe('fail');
  });
});
