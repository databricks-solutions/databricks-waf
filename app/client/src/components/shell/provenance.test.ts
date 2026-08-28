// The line under the page title, asserted rather than eyeballed.
//
// It is the most-read sentence in the app and the one that says what the numbers underneath it are
// of. The mistake it must not make is describing the wrong run: the version this tests replaced put
// a scan's time, lookback and catalogue version under the two pages a scan does not populate.

import { describe, expect, it } from 'vitest';
import {
  advisoryProvenance,
  resultProvenance,
  scanProvenance,
  type StampedAdvisory,
  type StampedScan,
} from './provenance';
import type { ScanStamp } from '../../api/types';

const stamp: ScanStamp = {
  catalogueVersion: '2026.07.1',
  catalogueFingerprint: 'sha256:ab12cd34ef5678901234',
  executionMode: 'on-behalf-of-user',
  actor: 'admin@example.com',
  trigger: 'interactive',
  scope: { description: 'The account, through the workspaces this identity can see.' },
  lookbackDays: 30,
};

const scan: StampedScan = { finishedAt: '2026-08-04T09:12:00.000Z', stamp };

const advisory: StampedAdvisory = { finishedAt: '2026-08-04T11:40:00.000Z', actor: 'admin@example.com' };

function measured(pillarId: string, measuredAt: string, carriedForward = false) {
  return { pillarId, scanId: 'scan-1', measuredAt, actor: 'admin@example.com', carriedForward };
}

describe('scanProvenance', () => {
  it('carries the three facts that make two runs incomparable', () => {
    const line = scanProvenance(scan);
    expect(line).toContain('as admin@example.com');
    expect(line).toContain('30-day lookback');
    expect(line).toContain('Pre-release development');
    expect(line).toContain('catalogue revision 2026.07.1');
  });

  it('names a schedule, and says nothing about a run somebody started themselves', () => {
    expect(scanProvenance({ ...scan, stamp: { ...stamp, trigger: 'scheduled' } })).toContain('on a schedule as');
    expect(scanProvenance(scan)).not.toContain('by hand');
  });

  it('says no scan has run rather than rendering an empty line', () => {
    expect(scanProvenance()).toBe('No scan has been run in this workspace yet.');
  });

  it('does not say a workspace has no scan while it is still looking for one', () => {
    // `/checks` said exactly that for three seconds above eighteen checks and their counts, all taken
    // from the scan the caption denied. The two states arrive as the same `undefined`, so the line is
    // only as honest as the flag beside it.
    const waiting = scanProvenance(undefined, { loading: true });
    expect(waiting).not.toContain('No scan has been run');
    expect(waiting).toBe('Looking for the most recent scan in this workspace.');
  });

  it('says a workspace has no scan once it has finished looking', () => {
    expect(scanProvenance(undefined, { loading: false })).toBe('No scan has been run in this workspace yet.');
  });

  it('describes the run it holds, whatever the flag says', () => {
    // A reload with a cached scan is loading and has an answer, and the answer is what the reader wants.
    expect(scanProvenance(scan, { loading: true })).toBe(scanProvenance(scan));
  });
});

describe('resultProvenance', () => {
  it('describes the publication without exposing result or source-run record keys', () => {
    const resultId = '696743ff-6248-46b4-b03f-010c3b858e0e';
    const runId = '10dcc283-3dc1-41ff-91be-c2befa242af0';
    const result = {
      id: resultId,
      runId,
      finalisedAt: '2026-08-21T04:46:00.000Z',
      finalisedBy: 'reviewer@example.com',
      assessment: {
        stamp: {
          ...stamp,
          publicMethodology: { publicVersion: 1, manifestDigest: 'sha256:manifest', state: 'released' as const },
        },
      },
    };
    const line = resultProvenance(result);

    expect(line).toContain('Published report');
    expect(line).toContain('reviewed');
    expect(line).not.toContain(resultId);
    expect(line).not.toContain(runId);
  });
});

describe('what the line says about how old the evidence is', () => {
  it('dates an ordinary run by its own finish, however its pillars are spread across it', () => {
    // Every measurement in a scan predates the moment the scan finished, so "older than finishedAt"
    // was true of all of them and rendered "Aug 4, 2026 to Aug 4, 2026, 9:12 AM" on a run where
    // nothing was carried forward at all — a range about nothing, which reads as a warning.
    const line = scanProvenance({
      ...scan,
      measurement: [
        measured('reliability', '2026-08-04T09:03:00.000Z'),
        measured('security', '2026-08-04T09:11:00.000Z'),
      ],
    });

    expect(line).not.toContain(' to ');
  });

  it('widens to a range when a pillar was carried forward, rather than dating it all by the rerun', () => {
    // The failure `MeasurementPayload` exists to prevent: a targeted rerun's result is minutes old in
    // one pillar and a week old in the rest, and one timestamp over it presents the week-old half as
    // current — in the most-read sentence in the app.
    const line = scanProvenance({
      ...scan,
      measurement: [
        measured('reliability', '2026-08-04T09:12:00.000Z'),
        measured('security', '2026-07-28T06:00:00.000Z', true),
      ],
    });

    expect(line).toMatch(/^Measured .+ to .+ as admin@example\.com/);
  });

  it('reports the range and does not judge it, because no threshold the app reads makes it stale', () => {
    // ADR 0091. Two dates are a fact the reader can act on; "stale" is a comparison against a number
    // nothing here holds, and the brief's warning status is declined for that reason.
    const line = scanProvenance({
      ...scan,
      measurement: [measured('security', '2026-01-01T00:00:00.000Z', true)],
    });

    expect(line).not.toMatch(/stale|out of date|old|overdue|refresh/i);
  });

  it('says nothing new on a run recorded before per-pillar measurement was kept', () => {
    expect(scanProvenance({ ...scan, measurement: [] })).toBe(scanProvenance(scan));
  });
});

describe('what the line says about scope', () => {
  it('gives the shape rather than the description, which was a tooltip nobody hovered', () => {
    const line = scanProvenance(scan);
    expect(line).toContain('all visible workspaces');
    expect(line).not.toContain(stamp.scope.description);
  });

  it('counts what an assessment named, and does not claim any of them answered', () => {
    const line = scanProvenance({ ...scan, stamp: { ...stamp, scope: { ...stamp.scope, selected: ['a', 'b', 'c'] } } });
    expect(line).toContain('3 workspaces');
  });

  it('reads a run narrowed by request as one workspace', () => {
    const line = scanProvenance({ ...scan, stamp: { ...stamp, scope: { ...stamp.scope, narrowedTo: 'w1' } } });
    expect(line).toContain('one workspace');
  });
});

describe('what the line says about the assessment', () => {
  it('names it, from the run’s own record rather than from the definition as it stands now', () => {
    const line = scanProvenance({
      ...scan,
      stamp: { ...stamp, definition: { id: 'def-1', version: 2, fingerprint: 'f', name: 'Lakehouse production' } },
    });

    expect(line).toContain('answering “Lakehouse production”');
  });

  it('separates a run that answered to nothing from one whose name was not kept', () => {
    expect(scanProvenance(scan)).toContain('answering no assessment');
    expect(
      scanProvenance({ ...scan, stamp: { ...stamp, definition: { id: 'def-1', version: 2, fingerprint: 'f' } } })
    ).toContain('answering an assessment this run did not name');
  });

  it('trims a name the author made long, because the caption has two lines and no more', () => {
    const line = scanProvenance({
      ...scan,
      stamp: {
        ...stamp,
        definition: {
          id: 'def-1',
          version: 2,
          fingerprint: 'f',
          name: 'Production readiness for the lakehouse migration programme',
        },
      },
    });

    expect(line).toContain('answering “Production readiness for the lakehouse…”');
  });
});

describe('advisoryProvenance', () => {
  it('says what the advisor did, in its own words rather than the assessment’s', () => {
    const line = advisoryProvenance(advisory);
    expect(line).toContain('Analysed');
    // The two vocabularies must not blur: none of these is true of an advisory run, and a reader with
    // both pages open tells the cycles apart by this line alone.
    expect(line).not.toContain('Measured');
    expect(line).not.toContain('lookback');
    expect(line).not.toContain('catalogue');
  });

  it('states no window, because the record’s lookback is not what either analysis read', () => {
    // Measured in labs: the record said thirty days, the query-shape statement caps itself at fifteen,
    // and this line sat above a page reading "the last 15 days of query history". Each page states the
    // window its own analysis used.
    expect(advisoryProvenance(advisory)).not.toMatch(/\d+-day/);
  });

  it('labels a service principal rather than printing a bare application id', () => {
    // The case ADR 0021 recorded: a scheduled advisory reaches the app as a service principal whose
    // name is a UUID, and an advisory record carries no execution mode to say so.
    const scheduled = { ...advisory, actor: '5af463d1-8cb9-4417-b2a5-725cea64cce5' };
    expect(advisoryProvenance(scheduled)).toContain('as service principal 5af463d1-8cb9-4417-b2a5-725cea64cce5');
  });

  it('says the advisor has not run rather than borrowing the scan’s sentence', () => {
    expect(advisoryProvenance()).toBe('The advisor has not run in this workspace yet.');
  });

  it('does not say the advisor has not run while it is still looking', () => {
    // The Optimisation pages read the estate live, so they draw themselves whatever the advisory does —
    // which is the property that made `/checks` show this class of sentence, on a different cycle.
    const waiting = advisoryProvenance(undefined, { loading: true });
    expect(waiting).not.toContain('has not run');
    expect(waiting).toBe('Looking for the most recent advisory run in this workspace.');
  });
});
