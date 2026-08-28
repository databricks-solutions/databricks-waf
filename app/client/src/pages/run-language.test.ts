// What a history row says, asserted rather than eyeballed.
//
// These cases are the ones a rerun feature gets wrong: a targeted run reading as a full one, a
// carried-forward result reading as freshly measured, and a run of 40 unreadable requirements
// adding up to a row that looks like 40 answered ones.

import { describe, expect, it } from 'vitest';
import {
  actorName,
  duration,
  identity,
  measured,
  requestSentence,
  results,
  startedBy,
  whoRan,
  whoRanInFull,
} from './run-language';
import type { OutcomeCounts, ScanSummary } from '../api/types';

const counts: OutcomeCounts = { pass: 0, fail: 0, partial: 0, unmeasurable: 0, notApplicable: 0 };

const title = (pillarId: string) => (pillarId === 'cost-optimisation' ? 'Cost optimisation' : pillarId);

describe('duration', () => {
  it('reports sub-second runs in milliseconds', () => {
    expect(duration({ startedAt: '2026-08-01T00:00:00.000Z', finishedAt: '2026-08-01T00:00:00.400Z' })).toBe('400ms');
  });

  it('reports a short scan in seconds', () => {
    expect(duration({ startedAt: '2026-08-01T00:00:00.000Z', finishedAt: '2026-08-01T00:00:42.000Z' })).toBe('42s');
  });

  it('reports a full scan, which takes minutes, in minutes', () => {
    expect(duration({ startedAt: '2026-08-01T00:00:00.000Z', finishedAt: '2026-08-01T00:02:30.000Z' })).toBe('2m 30s');
  });

  it('switches to minutes once seconds stop being readable', () => {
    expect(duration({ startedAt: '2026-08-01T00:00:00.000Z', finishedAt: '2026-08-01T00:03:05.000Z' })).toBe('3m 5s');
  });

  it('says unknown rather than inventing a negative duration', () => {
    expect(duration({ startedAt: '2026-08-01T00:05:00.000Z', finishedAt: '2026-08-01T00:00:00.000Z' })).toBe('unknown');
  });
});

describe('results', () => {
  it('leads with what is not met', () => {
    expect(results({ ...counts, fail: 12, pass: 30 })).toBe('12 not met, 30 met');
  });

  it('names unmeasured rather than folding it into a total', () => {
    expect(results({ ...counts, fail: 2, pass: 8, unmeasurable: 30 })).toBe('2 not met, 8 met, 30 unmeasured');
  });

  it('omits partial when there is none, so an empty count is not shown as a result', () => {
    expect(results({ ...counts, pass: 4 })).not.toContain('partly');
  });
});

describe('measured', () => {
  it('stays short for a full run', () => {
    expect(measured({ measuredPillars: ['a', 'b', 'c'], freshPillars: ['a', 'b', 'c'] })).toBe('3 measured');
  });

  it('says how much a targeted rerun carried forward', () => {
    expect(measured({ measuredPillars: ['a', 'b', 'c'], freshPillars: ['a'] })).toBe(
      '1 of 3 measured, 2 carried forward'
    );
  });

  it('will not present an entirely carried-forward result as measured', () => {
    expect(measured({ measuredPillars: ['a', 'b'], freshPillars: [] })).toBe('2 all carried forward');
  });

  it('says none rather than nothing when a run produced no pillars', () => {
    expect(measured({ measuredPillars: [], freshPillars: [] })).toBe('none');
  });
});

describe('requestSentence', () => {
  it('says nothing for a full run, since every row would otherwise carry a hedge', () => {
    expect(requestSentence({ freshPillars: ['cost-optimisation'] }, title)).toBeUndefined();
  });

  it('names the pillar a rerun was asked for', () => {
    expect(
      requestSentence({ requestedPillars: ['cost-optimisation'], freshPillars: ['cost-optimisation'] }, title)
    ).toBe('Rerun of Cost optimisation');
  });

  it('separates what was asked for from what came back', () => {
    expect(requestSentence({ requestedPillars: ['cost-optimisation'], freshPillars: [] }, title)).toBe(
      'Rerun of Cost optimisation, of which Cost optimisation produced no result'
    );
  });
});

describe('identity', () => {
  it('distinguishes the two identities, which see different estates', () => {
    expect(identity({ executionMode: 'on-behalf-of-user', actor: 'admin@example.com' })).toBe('signed-in user');
    expect(identity({ executionMode: 'service-principal', actor: 'app-1' })).toBe('service principal');
  });

  it('spots a service principal that came through the on-behalf-of door', () => {
    // The case that matters, and the one the old check got wrong. A scheduled run authenticates
    // as a service principal and the platform mints it an on-behalf-of token like any other, so
    // the mode says nothing — the application id does. Measured live, ADR 0021.
    const scheduled = { executionMode: 'on-behalf-of-user', actor: '5af463d1-8cb9-4417-b2a5-725cea64cce5' } as const;
    expect(identity(scheduled)).toBe('service principal');
    expect(actorName(scheduled)).toBe('service principal 5af463d1-8cb9-4417-b2a5-725cea64cce5');
  });

  it('leaves a person named as themselves', () => {
    const person = { executionMode: 'on-behalf-of-user', actor: 'admin@example.com' } as const;
    expect(actorName(person)).toBe('admin@example.com');
  });

  it('prefers the name a service principal calls itself, and keeps saying which kind it is', () => {
    // The defect this fixes: a scheduled run showed a bare UUID in the column where a colleague's
    // row shows an email. The label stays, because a name in that column would otherwise read as a
    // username, and only one of the two can be added to a group.
    const named = {
      executionMode: 'on-behalf-of-user',
      actor: '5af463d1-8cb9-4417-b2a5-725cea64cce5',
      actorName: 'waf-schedule-probe',
    } as const;
    expect(actorName(named)).toBe('service principal waf-schedule-probe');
    expect(whoRan(named)).toBe('waf-schedule-probe');
  });

  it('falls back to the identifier when no name was recorded', () => {
    // Every run from before the name was captured, and any run whose identity probe went unanswered.
    const older = { executionMode: 'on-behalf-of-user', actor: '5af463d1-8cb9-4417-b2a5-725cea64cce5' } as const;
    expect(whoRan(older)).toBe('5af463d1-8cb9-4417-b2a5-725cea64cce5');
    expect(whoRanInFull(older)).toBe('5af463d1-8cb9-4417-b2a5-725cea64cce5');
  });

  it('does not let a display name stand in for a person, who is already named by something lookupable', () => {
    const person = { executionMode: 'on-behalf-of-user', actor: 'admin@example.com', actorName: 'Ada Lovelace' } as const;
    expect(actorName(person)).toBe('admin@example.com');
  });

  it('carries both where the panel has to be enough to repeat the reading', () => {
    expect(whoRanInFull({ actor: '5af463d1-8cb9-4417-b2a5-725cea64cce5', actorName: 'waf-schedule-probe' })).toBe(
      'waf-schedule-probe (5af463d1-8cb9-4417-b2a5-725cea64cce5)'
    );
  });

  it('ignores a name that is only whitespace rather than printing a gap', () => {
    expect(whoRan({ actor: '5af463d1-8cb9-4417-b2a5-725cea64cce5', actorName: '  ' })).toBe(
      '5af463d1-8cb9-4417-b2a5-725cea64cce5'
    );
  });
});

describe('startedBy', () => {
  it('says whether anybody was watching', () => {
    expect(startedBy({ trigger: 'scheduled' })).toBe('on a schedule');
    expect(startedBy({ trigger: 'interactive' })).toBe('by hand');
  });

  it('says nothing for a run that did not record it, rather than guessing the commoner case', () => {
    expect(startedBy({})).toBeUndefined();
  });
});

/** Guards the assumption above that a summary's dates arrive as strings over the wire. */
it('reads the dates in the shape the API sends them', () => {
  const summary: Pick<ScanSummary, 'startedAt' | 'finishedAt'> = {
    startedAt: '2026-08-01T00:00:00.000Z',
    finishedAt: '2026-08-01T00:00:20.000Z',
  };
  expect(duration(summary)).toBe('20s');
});
