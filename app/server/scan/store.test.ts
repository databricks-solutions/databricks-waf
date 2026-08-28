// What a history row carries about a run it does not open.
//
// The summary holds three fields the stamp also holds, and that overlap is the thing worth a test:
// the flat fields are what the history page renders and the stamp is what a comparison reads, so a
// disagreement between them would show a reader one identity on a row and refuse a comparison over
// a different one, with nothing on either surface to explain it.

import { describe, expect, it } from 'vitest';
import { summarise } from './store.js';
import type { Scan, ScanStamp } from './scan.js';
import type { Finding, Outcome } from '../resolve/finding.js';
import { CollectionScheduler } from './scheduler.js';

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
  const stamp: ScanStamp = {
    catalogueVersion: '9',
    catalogueFingerprint: 'nine',
    executionMode: 'service-principal',
    actor: 'sp-4718',
    scope: { description: 'the whole account' },
    lookbackDays: 30,
  };

  return {
    id: 'now',
    state: 'complete',
    startedAt: new Date('2026-08-03T09:00:00.000Z'),
    finishedAt: new Date('2026-08-03T09:05:00.000Z'),
    stamp,
    findings: [finding('REL-01-01', 'fail'), finding('DG-01-01', 'pass')],
    signals: [],
    score: { overall: 50, pillars: [], composition: { observed: 2, adminCollected: 0, attested: 0 } },
    measurement: [],
    scheduler: new CollectionScheduler(),
    ...one,
  } as Scan;
}

describe('the summary a history row is drawn from', () => {
  it('says the same thing twice rather than two different things', () => {
    const summary = summarise(scan());

    expect(summary.actor).toBe(summary.stamp?.actor);
    expect(summary.executionMode).toBe(summary.stamp?.executionMode);
    expect(summary.catalogueVersion).toBe(summary.stamp?.catalogueVersion);
  });

  it('records what each requirement found, so a history need not open the run', () => {
    expect(summarise(scan()).outcomes).toEqual({ 'REL-01-01': 'fail', 'DG-01-01': 'pass' });
  });

  it('carries the whole stamp, which is what a comparison reads', () => {
    expect(summarise(scan()).stamp).toEqual(scan().stamp);
  });

  it('carries the range, so a history row can withhold a verdict the run withheld', () => {
    const range = { low: 14.2, high: 91.8 };
    const scored = scan({ score: { ...scan().score, overall: 65.3, range } });

    expect(summarise(scored).range).toEqual(range);
  });

  it('omits it where the score has none, rather than inventing a width', () => {
    expect(summarise(scan())).not.toHaveProperty('range');
  });
});
