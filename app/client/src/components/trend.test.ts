import { describe, expect, it } from 'vitest';
import type { ScanStamp, ScanSummary } from '../api/types';
import { pillarSeries, type SeriesPoint } from './trend';

/**
 * A stamp with one field taken out of it, the way a value truncated by a partial write arrives.
 *
 * Built by deleting from a whole one rather than by asserting a literal into place: the point of these
 * fixtures is a stamp the *type* says is complete and the *value* is not, which is exactly what comes
 * out of a `jsonb` column, and a cast from a literal that never had the field is a different fixture.
 */
type Loose<TRecord> = { -readonly [TKey in keyof TRecord]?: TRecord[TKey] };

function withoutScope(): ScanStamp {
  const draft: Loose<ScanStamp> = { ...stamp() };
  delete draft.scope;
  return draft as ScanStamp;
}

function withoutSources(): ScanStamp {
  type Identity = NonNullable<ScanStamp['identity']>;
  const identity: Loose<Identity> = { ...stamp().identity };
  delete identity.sources;
  return { ...stamp(), identity: identity as Identity };
}

/** The verdict on a point whose basis was read, which is what most of these assert about. */
function verdictOf(point: SeriesPoint | undefined) {
  if (point == null || !point.basis.read) throw new Error('expected a point whose basis was read');
  return point.basis.verdict;
}

const PILLAR = 'security-compliance-and-privacy';

function stamp(change: Partial<ScanStamp> = {}): ScanStamp {
  return {
    publicMethodology: {
      publicVersion: 1,
      manifestDigest: 'sha256:manifest',
      state: 'released',
      effectiveDate: '2026-09-01',
    },
    catalogueVersion: '10',
    catalogueFingerprint: 'sha256:catalogue',
    executionMode: 'on-behalf-of-user',
    actor: 'admin@example.com',
    scope: { description: 'the whole account' },
    lookbackDays: 30,
    assessedWorkspaces: ['one'],
    identity: {
      build: { id: '0.1.0+aaaaaaaaaaaa' },
      methodology: { id: 'sha256:method' },
      record: { id: 'codec-2' },
      sources: ['sql'],
      exclusions: [],
    },
    ...change,
  };
}

function summary(id: string, score: number, basis: ScanStamp | undefined): ScanSummary {
  return {
    id,
    startedAt: `2026-08-0${id}T00:00:00.000Z`,
    finishedAt: `2026-08-0${id}T00:01:00.000Z`,
    state: 'complete',
    overall: score,
    actor: basis?.actor ?? 'unknown',
    executionMode: basis?.executionMode ?? 'on-behalf-of-user',
    catalogueVersion: basis?.catalogueVersion ?? 'unknown',
    measuredPillars: [PILLAR],
    freshPillars: [PILLAR],
    counts: { pass: 1, fail: 0, partial: 0, unmeasurable: 0, notApplicable: 0 },
    pillarScores: { [PILLAR]: score },
    ...(basis != null ? { stamp: basis } : {}),
  };
}

describe('pillar trend comparability', () => {
  it('retains a refused point and the full server reason instead of dropping it', () => {
    const current = stamp();
    const changedWindow = stamp({ lookbackDays: 90 });
    const series = pillarSeries([summary('3', 73, current), summary('2', 80, changedWindow)], PILLAR, current);

    expect(series.points).toHaveLength(2);
    expect(verdictOf(series.points[0]).ok).toBe(false);
    expect(verdictOf(series.points[0]).reason).toContain('different windows');
    expect(series.values).toEqual([73]);
  });

  /*
   * A run recorded before the basis was kept is not a refusal. `occurrence.ts` keeps the two apart on
   * the server — a run it could not read against a run it read and found incomparable — and rendering
   * this one as refused would report a record older than the field as a change in what was measured.
   */
  it('keeps a pre-stamp run apart from a refusal rather than reporting it as one', () => {
    const current = stamp();
    const series = pillarSeries([summary('2', 73, current), summary('1', 69, undefined)], PILLAR, current);

    const older = series.points[0];
    expect(older?.basis.read).toBe(false);
    expect(older?.basis.read === false ? older.basis.why : '').toContain('does not record the full basis');
    expect(series.values).toEqual([73]);
  });

  /*
   * A stamp arrives over HTTP out of the same `jsonb` column the server guards with `stampEnough`, so a
   * truncated one is a value rather than a type error. Unguarded, `comparable` dereferenced `scope` and
   * `identity.sources` and threw inside a pillar row's own render — which is the dashboard, not a pane.
   */
  it('declines to compare a truncated stamp instead of throwing while a row renders', () => {
    const current = stamp();
    const series = pillarSeries(
      [summary('3', 73, current), summary('2', 70, withoutScope()), summary('1', 69, withoutSources())],
      PILLAR,
      current
    );

    expect(series.points.map((point) => point.basis.read)).toEqual([false, false, true]);
    expect(series.values).toEqual([73]);
  });

  it('declines every comparison where the run in hand is the one with the truncated stamp', () => {
    const series = pillarSeries([summary('2', 73, stamp()), summary('1', 69, stamp())], PILLAR, withoutScope());

    expect(series.points.every((point) => !point.basis.read)).toBe(true);
    expect(series.values).toEqual([]);
    expect(series.delta).toBeUndefined();
  });

  it('permits version labels that changed without changing the catalogue fingerprint', () => {
    const current = stamp();
    const renamedRelease = stamp({ catalogueVersion: '9' });
    const series = pillarSeries([summary('2', 73, current), summary('1', 69, renamedRelease)], PILLAR, current);

    expect(series.values).toEqual([69, 73]);
    expect(series.delta).toBe(4);
  });

  it('refuses a change in the applicability exclusions that formed the denominator', () => {
    const current = stamp();
    const previous = stamp({ identity: { ...current.identity!, exclusions: ['SEC-01-01:disabled'] } });
    const series = pillarSeries([summary('2', 73, current), summary('1', 69, previous)], PILLAR, current);

    expect(verdictOf(series.points[0]).reason).toContain('different denominators');
  });

  it('draws permitted caveats and carries their qualification', () => {
    const current = stamp();
    const previous = stamp({ identity: { ...current.identity!, build: { id: '0.0.9+bbbbbbbbbbbb' } } });
    const series = pillarSeries([summary('2', 73, current), summary('1', 69, previous)], PILLAR, current);

    expect(series.values).toEqual([69, 73]);
    expect(verdictOf(series.points[0]).ok).toBe(true);
    expect(verdictOf(series.points[0]).caveat).toContain('different builds');
  });

  it('does not repeat a carried-forward pillar as a fresh stable point', () => {
    const current = stamp();
    const carried = { ...summary('2', 73, current), freshPillars: [] };
    const series = pillarSeries([summary('3', 73, current), carried, summary('1', 69, current)], PILLAR, current);

    expect(series.points.map((point) => point.value)).toEqual([69, 73]);
  });
});
