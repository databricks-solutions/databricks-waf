import { describe, expect, it } from 'vitest';
import type { WorkspaceDirectory, WorkspaceRow } from '../collect/sql/shapes.js';
import {
  archive,
  currentVersion,
  define,
  fingerprintOf,
  resolveScope,
  revise,
  unarchive,
  type Draft,
  type Measurement,
} from './definition.js';

const AT = new Date('2026-08-03T00:00:00Z');
const LATER = new Date('2026-08-04T00:00:00Z');
const BY = 'alice@example.com';

const DRAFT: Draft = {
  measurement: { scope: { kind: 'selected', workspaceIds: ['w2', 'w1'] }, lookbackDays: 30 },
  attribution: { name: 'Q3 platform review', owners: ['alice@example.com'] },
};

function workspace(id: string, over: Partial<WorkspaceRow> = {}): WorkspaceRow {
  return { workspaceId: id, name: `Workspace ${id}`, status: 'RUNNING', live: true, ...over };
}

// A home region by default, because that is the ordinary case and its absence is a caveat every
// description then carries. A test about that absence uses `unplaced` below and says so in its name.
function directory(over: Partial<WorkspaceDirectory> = {}): WorkspaceDirectory {
  const live = over.live ?? [workspace('w1'), workspace('w2')];
  return {
    workspaces: over.workspaces ?? [...live, ...(over.excluded ?? [])],
    live,
    excluded: over.excluded ?? [],
    regionUnverified: over.regionUnverified ?? [],
    outOfScope: over.outOfScope ?? [],
    homeRegion: over.homeRegion ?? 'us-east-1',
  };
}

/** The same estate with no home region established, which is what `scopedToRegion` leaves behind. */
function unplaced(over: Partial<WorkspaceDirectory> = {}): WorkspaceDirectory {
  const { homeRegion: _ignored, ...rest } = directory(over);
  return rest;
}

// The stored comparability key, pinned to literals.
//
// Every other fingerprint assertion in this file compares two values computed in the same process, and
// all of them keep passing if the hashed document gains a field, renames one, or stops sorting — while
// every fingerprint already written to Lakebase stops matching, every trend line silently ends, and
// the app reports a fresh history for an assessment nobody changed. That is the exact failure the
// fingerprint exists to prevent, and a same-process comparison cannot see it.
//
// So these are literals. If one of them fails, the question is not "what is the new hash" — it is
// whether ending every existing trend is intended. If it is, the hashed document needs a version
// field, so that the break is a thing the importer can recognise rather than a silent mismatch.
describe('the fingerprint of a measurement', () => {
  it('is this exact value for the whole account over thirty days', () => {
    expect(fingerprintOf({ scope: { kind: 'account' }, lookbackDays: 30 })).toBe(
      'sha256:72510a9de525a476e97bb9c64cf00dcb03eeb845b54123afcd11f33f1264b5fa'
    );
  });

  it('is this exact value for a selection, whatever order it arrives in', () => {
    const expected = 'sha256:b57b15d51e20fe97cf8ae20becaa94ce379fdec375474547aa743403fd30ff08';
    expect(fingerprintOf({ scope: { kind: 'selected', workspaceIds: ['w2', 'w1'] }, lookbackDays: 30 })).toBe(expected);
    expect(fingerprintOf({ scope: { kind: 'selected', workspaceIds: ['w1', 'w2'] }, lookbackDays: 30 })).toBe(expected);
  });

  it('is this exact value for a pillar subset', () => {
    expect(fingerprintOf({ scope: { kind: 'account' }, lookbackDays: 30, pillars: ['security', 'cost'] })).toBe(
      'sha256:ba50df19befec379c7b84b9a9d796de978d83af1438cf3fb0bf45aa880d501ed'
    );
  });

  // The most delicate rule in the module, and it had no test at all. An absent pillar list means every
  // pillar the catalogue holds; a list naming all of them is a subset that happens to be complete. They
  // are different documents and hash differently, deliberately — which puts a requirement on whatever
  // UI presents the pillars as checkboxes: seven ticked boxes must serialise as *absent*, or two
  // definitions meaning the same thing get different fingerprints and a UI change breaks trends.
  it('distinguishes an absent pillar list from one naming every pillar', () => {
    const absent = fingerprintOf({ scope: { kind: 'account' }, lookbackDays: 30 });
    const all = fingerprintOf({
      scope: { kind: 'account' },
      lookbackDays: 30,
      pillars: ['security', 'cost', 'reliability', 'performance', 'operations', 'governance', 'interoperability'],
    });
    expect(all).not.toBe(absent);
  });

  it('changes with the pillar set, and not with its order', () => {
    const one = fingerprintOf({ scope: { kind: 'account' }, lookbackDays: 30, pillars: ['security', 'cost'] });
    expect(fingerprintOf({ scope: { kind: 'account' }, lookbackDays: 30, pillars: ['cost', 'security'] })).toBe(one);
    expect(fingerprintOf({ scope: { kind: 'account' }, lookbackDays: 30, pillars: ['security'] })).not.toBe(one);
  });
});

describe('defining an assessment', () => {
  it('starts at version 1 and sorts the workspaces it was given', () => {
    const definition = define(DRAFT, 'd1', AT, BY);
    const version = currentVersion(definition);

    expect(version.version).toBe(1);
    expect(version.createdBy).toBe(BY);
    expect(version.measurement.scope).toEqual({ kind: 'selected', workspaceIds: ['w1', 'w2'] });
    expect(version.note).toBeUndefined();
  });

  /*
   * The reason the fingerprint is over the measurement alone. Two authors describing the same
   * estate in a different order have asked the same question, and a trend that broke because
   * somebody clicked the workspaces in a different sequence would be indefensible.
   */
  it('fingerprints the same estate identically however it was written down', () => {
    const one: Measurement = { scope: { kind: 'selected', workspaceIds: ['w1', 'w2'] }, lookbackDays: 30 };
    const other: Measurement = { scope: { kind: 'selected', workspaceIds: ['w2', 'w1', 'w2'] }, lookbackDays: 30 };

    expect(fingerprintOf(one)).toBe(fingerprintOf(other));
  });

  it('separates account reach from a selection that happens to name every workspace', () => {
    const account = fingerprintOf({ scope: { kind: 'account' }, lookbackDays: 30 });
    const everything = fingerprintOf({
      scope: { kind: 'selected', workspaceIds: ['w1', 'w2'] },
      lookbackDays: 30,
    });

    // The same coverage today and a different claim: one follows the identity's grants and the
    // other does not, so a grant widening changes the first assessment and leaves the second alone.
    expect(account).not.toBe(everything);
  });

  it('refuses a lookback the system tables cannot answer, and an empty selection', () => {
    const bad = (measurement: Measurement) => () => define({ ...DRAFT, measurement }, 'd1', AT, BY);

    expect(bad({ scope: { kind: 'account' }, lookbackDays: 0 })).toThrow(/1 to 365/);
    expect(bad({ scope: { kind: 'account' }, lookbackDays: 400 })).toThrow(/1 to 365/);
    expect(bad({ scope: { kind: 'account' }, lookbackDays: 1.5 })).toThrow(/whole number/);
    expect(bad({ scope: { kind: 'selected', workspaceIds: [] }, lookbackDays: 30 })).toThrow(/at least one/);
    expect(bad({ scope: { kind: 'account' }, lookbackDays: 30, pillars: [] })).toThrow(/Omit the list/);
  });

  it('needs a name somebody can ask for it by', () => {
    expect(() => define({ ...DRAFT, attribution: { name: '   ', owners: [] } }, 'd1', AT, BY)).toThrow(/name/);
  });

  it('accepts an assessment nobody has claimed yet', () => {
    const definition = define({ ...DRAFT, attribution: { name: 'Unowned', owners: [] } }, 'd1', AT, BY);
    expect(currentVersion(definition).attribution.owners).toEqual([]);
  });

  /*
   * A version records who decided it, and a blank author answers none of the questions a version history
   * exists to answer. Refused rather than replaced with a placeholder: every caller has already
   * established an actor in order to be allowed here, so a blank one is a bug in that, and filling it in
   * would hide it.
   */
  it('refuses a version nobody is attributed with', () => {
    expect(() => define(DRAFT, 'd1', AT, '  ')).toThrow(/no one was named/);
    const first = define(DRAFT, 'd1', AT, BY);
    expect(() => revise(first, { note: 'why' }, AT, '')).toThrow(/no one was named/);
  });

  /*
   * ' w1' and 'w1' are one estate under two fingerprints, and a fingerprint is what two runs compare on.
   * The pasted-list case is the realistic one, and it produced a definition that could never be compared
   * against the same definition typed by hand.
   */
  it('reads a pasted id with a stray space as the same estate', () => {
    const spaced: Measurement = { scope: { kind: 'selected', workspaceIds: [' w1', 'w2 ', 'w1'] }, lookbackDays: 30 };
    const typed: Measurement = { scope: { kind: 'selected', workspaceIds: ['w1', 'w2'] }, lookbackDays: 30 };

    const definition = define({ ...DRAFT, measurement: spaced }, 'd1', AT, BY);
    expect(currentVersion(definition).measurement.scope).toEqual({ kind: 'selected', workspaceIds: ['w1', 'w2'] });
    expect(currentVersion(definition).fingerprint).toBe(fingerprintOf(typed));
  });

  /*
   * Refused rather than dropped. Dropping it turns a selection of three workspaces into one of two, at a
   * stable fingerprint — the shape of error this module exists to make impossible, since the trend reads
   * as healthy while a workspace nobody removed goes unmeasured.
   */
  it('refuses a blank id rather than quietly narrowing the selection', () => {
    const blank: Measurement = { scope: { kind: 'selected', workspaceIds: ['w1', '  '] }, lookbackDays: 30 };
    expect(() => define({ ...DRAFT, measurement: blank }, 'd1', AT, BY)).toThrow(/blank workspace id/);

    const pillars: Measurement = { scope: { kind: 'account' }, lookbackDays: 30, pillars: ['security', ''] };
    expect(() => define({ ...DRAFT, measurement: pillars }, 'd1', AT, BY)).toThrow(/blank pillar id/);
  });
});

describe('revising an assessment', () => {
  /*
   * The whole point of the measurement/attribution split, in one assertion. Correcting a name must
   * not end the customer's history, or nobody will ever correct one.
   */
  it('keeps the fingerprint when only the attribution changed', () => {
    const first = define(DRAFT, 'd1', AT, BY);
    const second = revise(first, { attribution: { name: 'Q3 platform review (EMEA)', owners: [BY] } }, LATER, BY);

    expect(currentVersion(second).version).toBe(2);
    expect(currentVersion(second).fingerprint).toBe(currentVersion(first).fingerprint);
    expect(currentVersion(second).attribution.name).toBe('Q3 platform review (EMEA)');
  });

  it('changes the fingerprint when the estate changed', () => {
    const first = define(DRAFT, 'd1', AT, BY);
    const second = revise(
      first,
      { measurement: { scope: { kind: 'selected', workspaceIds: ['w1', 'w2', 'w3'] }, lookbackDays: 30 } },
      LATER,
      BY,
    );

    expect(currentVersion(second).fingerprint).not.toBe(currentVersion(first).fingerprint);
  });

  it('keeps every earlier version, because a finished run points at one', () => {
    const first = define(DRAFT, 'd1', AT, BY);
    const second = revise(first, { attribution: { name: 'Renamed', owners: [BY] } }, LATER, BY);

    expect(second.versions.map((one) => one.version)).toEqual([1, 2]);
    expect(second.versions[0]?.attribution.name).toBe('Q3 platform review');
  });

  it('refuses a revision that changes nothing', () => {
    const first = define(DRAFT, 'd1', AT, BY);

    expect(() => revise(first, { measurement: DRAFT.measurement }, LATER, BY)).toThrow(/change nothing/);
    // Including one that only reorders a set, which is the same claim written differently.
    expect(() =>
      revise(
        first,
        { measurement: { scope: { kind: 'selected', workspaceIds: ['w2', 'w1'] }, lookbackDays: 30 } },
        LATER,
        BY,
      ),
    ).toThrow(/change nothing/);
  });

  it('records the author’s note on the version that changed, not the one that did not', () => {
    const first = define(DRAFT, 'd1', AT, BY);
    const second = revise(first, { attribution: { name: 'Renamed', owners: [BY] }, note: 'Owner left' }, LATER, BY);

    expect(second.versions[0]?.note).toBeUndefined();
    expect(second.versions[1]?.note).toBe('Owner left');
  });

  it('refuses to revise an archived definition, and archiving twice is not a change', () => {
    const closed = archive(define(DRAFT, 'd1', AT, BY), LATER);

    expect(() => revise(closed, { attribution: { name: 'Reopened', owners: [] } }, LATER, BY)).toThrow(/archived/);
    expect(archive(closed, new Date('2026-09-01T00:00:00Z')).archivedAt).toEqual(LATER);
  });

  it('reopens an archived definition without the key lingering, and lets it be revised again', () => {
    const closed = archive(define(DRAFT, 'd1', AT, BY), LATER);

    const reopened = unarchive(closed);

    // Deleted rather than set to undefined: `'archivedAt' in definition` is how the payload decides
    // whether to send the field, so a lingering key would tell every client it is still archived.
    expect('archivedAt' in reopened).toBe(false);
    expect(reopened.versions).toEqual(closed.versions);
    expect(() =>
      revise(reopened, { attribution: { name: 'Reopened', owners: [] } }, LATER, BY)
    ).not.toThrow();
  });

  it('reopening one that was never archived returns it untouched', () => {
    const open = define(DRAFT, 'd1', AT, BY);

    expect(unarchive(open)).toBe(open);
  });
});

describe('resolving a scope against the estate as it is now', () => {
  it('covers the live directory under account reach, and names nothing as missing', () => {
    const resolved = resolveScope({ scope: { kind: 'account' }, lookbackDays: 30 }, directory());

    expect(resolved.assessed.map((one) => one.workspaceId)).toEqual(['w1', 'w2']);
    expect(resolved.omitted).toEqual([]);
    expect(resolved.outOfScope).toEqual([]);
    expect(resolved.complete).toBe(true);
    // Says the thing that makes account reach different from a chosen set, rather than only a count.
    expect(resolved.description).toContain('grants');
  });

  it('separates what was left out on purpose from what could not be reached', () => {
    const resolved = resolveScope(
      { scope: { kind: 'selected', workspaceIds: ['w1'] }, lookbackDays: 30 },
      directory(),
    );

    expect(resolved.assessed.map((one) => one.workspaceId)).toEqual(['w1']);
    expect(resolved.outOfScope.map((one) => one.workspaceId)).toEqual(['w2']);
    // Deliberately out of scope is not an omission, and the assessment is complete despite it.
    expect(resolved.omitted).toEqual([]);
    expect(resolved.complete).toBe(true);
  });

  it('reports a named workspace that stopped running as stopped, not as missing', () => {
    const resolved = resolveScope(
      { scope: { kind: 'selected', workspaceIds: ['w1', 'w9'] }, lookbackDays: 30 },
      directory({
        live: [workspace('w1')],
        excluded: [{ ...workspace('w9', { status: 'BANNED', live: false }), reason: 'not-running' }],
      }),
    );

    expect(resolved.omitted).toEqual([
      { workspaceId: 'w9', name: 'Workspace w9', status: 'BANNED', reason: 'not-running' },
    ]);
    expect(resolved.complete).toBe(false);
    expect(resolved.description).toContain('no longer running');
  });

  it('says a workspace in another region is one a deployment there would cover', () => {
    const resolved = resolveScope(
      { scope: { kind: 'selected', workspaceIds: ['w1', 'w8'] }, lookbackDays: 30 },
      directory({
        live: [workspace('w1')],
        excluded: [{ ...workspace('w8'), reason: 'other-region' }],
      }),
    );

    expect(resolved.omitted[0]?.reason).toBe('other-region');
    expect(resolved.description).toContain('another region');
    // Not conflated with a cancelled workspace: this one is a real part of the estate.
    expect(resolved.description).not.toContain('cancelled');
  });

  /*
   * The case the whole `unknown` reason exists for. A workspace named by the definition and absent
   * from the directory is either gone or invisible, and those are opposite events — one is the
   * estate shrinking, the other the observer. Naming either would state something nobody measured.
   */
  it('refuses to guess why a named workspace is absent from the directory', () => {
    const resolved = resolveScope(
      { scope: { kind: 'selected', workspaceIds: ['w1', 'ghost'] }, lookbackDays: 30 },
      directory({ live: [workspace('w1')] }),
    );

    expect(resolved.omitted).toEqual([{ workspaceId: 'ghost', reason: 'unknown' }]);
    expect(resolved.complete).toBe(false);
    expect(resolved.description).toContain('cancelled');
    expect(resolved.description).toContain('loses the grant');
    // And says the assessment is short of its own claim, which is the actionable part.
    expect(resolved.description).toContain('covers less than it claims');
  });

  it('counts rather than lists when there are too many names to read', () => {
    const missing = ['g1', 'g2', 'g3', 'g4'];
    const resolved = resolveScope(
      { scope: { kind: 'selected', workspaceIds: ['w1', ...missing] }, lookbackDays: 30 },
      directory({ live: [workspace('w1')] }),
    );

    expect(resolved.omitted).toHaveLength(4);
    expect(resolved.description).toContain('4 workspaces');
  });

  it('describes a fully covered selection without a caveat about it', () => {
    const resolved = resolveScope(
      { scope: { kind: 'selected', workspaceIds: ['w1', 'w2'] }, lookbackDays: 30 },
      directory(),
    );

    expect(resolved.description).toBe('Assessed 2 of the 2 workspaces this assessment covers.');
  });

  /*
   * Region is inferred from billing rows over the lookback, so "assessed" and "placed" are different
   * claims. A description that made the first without qualifying the second read as more certain than
   * the data behind it — and the remedy, a longer window, is not one a reader would guess.
   */
  it('says when an assessed workspace was never placed in a region', () => {
    const resolved = resolveScope(
      { scope: { kind: 'selected', workspaceIds: ['w1', 'w2'] }, lookbackDays: 30 },
      directory({ regionUnverified: [workspace('w2')] }),
    );

    expect(resolved.regionUnverified.map((one) => one.workspaceId)).toEqual(['w2']);
    expect(resolved.description).toContain('1 of 2 was assessed without confirming the region');
    expect(resolved.description).toContain('longer window');
  });

  // A workspace deliberately left out has no region question to answer, and a caveat about it would be
  // about workspaces this assessment is not of.
  it('ignores an unplaced workspace that the scope left out anyway', () => {
    const resolved = resolveScope(
      { scope: { kind: 'selected', workspaceIds: ['w1'] }, lookbackDays: 30 },
      directory({ regionUnverified: [workspace('w2')] }),
    );

    expect(resolved.regionUnverified).toEqual([]);
    expect(resolved.description).toBe(
      'Assessed 1 of the 1 workspace this assessment covers. 1 further workspace in the account is deliberately outside it.'
    );
  });

  /*
   * The worse case, and the reason it is a flag rather than a count. With no home region nothing is
   * filtered, so every workspace stays in scope and a run may be reading across regions that bill
   * separately — which is a different warning from "one workspace was quiet".
   */
  it('says when the region it reads was never established at all', () => {
    const resolved = resolveScope(
      { scope: { kind: 'selected', workspaceIds: ['w1', 'w2'] }, lookbackDays: 30 },
      unplaced(),
    );

    expect(resolved.homeRegionUndetermined).toBe(true);
    expect(resolved.description).toContain('Which region this deployment reads was not established');
    expect(resolved.description).toContain('may be reading across them');
  });

  /*
   * Two facts share the `unknown` reason. This is the one the old sentence misdescribed: a workspace the
   * directory has a row for is present and unclassified, and calling it "not in the directory at all"
   * contradicted the row the resolution had just read from.
   */
  it('does not call a workspace absent when the directory has a row for it', () => {
    const listed = workspace('w9', { status: 'PROVISIONING', live: false });
    const resolved = resolveScope(
      { scope: { kind: 'selected', workspaceIds: ['w1', 'w9'] }, lookbackDays: 30 },
      directory({ workspaces: [workspace('w1'), workspace('w2'), listed] }),
    );

    expect(resolved.omitted).toEqual([
      { workspaceId: 'w9', name: 'Workspace w9', status: 'PROVISIONING', reason: 'unknown' },
    ]);
    expect(resolved.description).toContain('is in the account directory, which does not say whether it is running');
    expect(resolved.description).not.toContain('not in the account directory at all');
  });

  /*
   * The directory is behind a grant of its own, so "could not be read" is a state a resolution has to be
   * able to hold. Before it could, the only way to call this was with an empty directory — which reported
   * every named workspace as absent and blamed the estate for a permission error.
   */
  it('says the coverage is unknown rather than empty when there was no directory', () => {
    const resolved = resolveScope(
      { scope: { kind: 'selected', workspaceIds: ['w1', 'w2'] }, lookbackDays: 30 },
      undefined,
      'The workspace directory is in Public Preview and this account cannot read it.',
    );

    expect(resolved.complete).toBe(false);
    expect(resolved.omitted).toEqual([]);
    expect(resolved.assessed).toEqual([]);
    expect(resolved.description).toContain('2 named workspaces');
    expect(resolved.description).toContain('could not be established');
    expect(resolved.description).toContain('Public Preview');
  });
});

describe('what an assessment commits to', () => {
  const BY_DATE = new Date('2026-09-30T00:00:00Z');

  function withTargets(targets: Draft['targets'], measurement: Measurement = DRAFT.measurement): Draft {
    return { ...DRAFT, measurement, ...(targets != null ? { targets } : {}) };
  }

  it('is absent rather than empty when nothing was committed', () => {
    // One shape for "committed to nothing", so a reader checking the key and a reader checking the
    // length cannot reach different answers.
    expect(currentVersion(define(DRAFT, 'd1', AT, BY)).targets).toBeUndefined();
    expect(currentVersion(define(withTargets([]), 'd1', AT, BY)).targets).toBeUndefined();
  });

  it('records a target against the pillar it is for', () => {
    const version = currentVersion(
      define(withTargets([{ pillar: 'security', atLeast: 80, by: BY_DATE }]), 'd1', AT, BY)
    );

    expect(version.targets).toEqual([{ pillar: 'security', atLeast: 80, by: BY_DATE }]);
  });

  it('does not change the fingerprint, because a commitment is not part of what is measured', () => {
    // The property that decides where this field lives. Fingerprinting it would mean setting a target
    // ended the customer's trend line, which is the one outcome guaranteed to stop anybody setting one.
    const without = currentVersion(define(DRAFT, 'd1', AT, BY));
    const with_ = currentVersion(define(withTargets([{ pillar: 'security', atLeast: 80, by: BY_DATE }]), 'd2', AT, BY));

    expect(with_.fingerprint).toBe(without.fingerprint);
  });

  it('sorts by pillar, so a reordering does not read as a change', () => {
    const version = currentVersion(
      define(
        withTargets([
          { pillar: 'security', atLeast: 80, by: BY_DATE },
          { pillar: 'cost-optimization', atLeast: 60, by: BY_DATE },
        ]),
        'd1',
        AT,
        BY
      )
    );

    expect(version.targets?.map((target) => target.pillar)).toEqual(['cost-optimization', 'security']);
  });

  it('refuses two targets for one pillar rather than keeping one of them', () => {
    // Silently keeping the last would decide which of two numbers the customer committed to.
    expect(() =>
      define(
        withTargets([
          { pillar: 'security', atLeast: 80, by: BY_DATE },
          { pillar: 'security', atLeast: 90, by: BY_DATE },
        ]),
        'd1',
        AT,
        BY
      )
    ).toThrow(/two targets for security/);
  });

  it('refuses a target for a pillar the assessment does not measure', () => {
    // It could never be reported against, so it would sit in the document looking like a commitment
    // and behaving like nothing — while the author believes they have set it.
    expect(() =>
      define(
        withTargets([{ pillar: 'reliability', atLeast: 80, by: BY_DATE }], {
          ...DRAFT.measurement,
          pillars: ['security'],
        }),
        'd1',
        AT,
        BY
      )
    ).toThrow(/does not measure reliability/);
  });

  it('allows any pillar when the assessment covers all of them', () => {
    expect(() =>
      define(withTargets([{ pillar: 'reliability', atLeast: 80, by: BY_DATE }]), 'd1', AT, BY)
    ).not.toThrow();
  });

  it('refuses a score outside what a score can be, including nothing to aim at', () => {
    for (const atLeast of [0, -1, 101, 80.5]) {
      expect(() => define(withTargets([{ pillar: 'security', atLeast, by: BY_DATE }]), 'd1', AT, BY)).toThrow();
    }
    for (const atLeast of [1, 100]) {
      expect(() =>
        define(withTargets([{ pillar: 'security', atLeast, by: BY_DATE }]), 'd1', AT, BY)
      ).not.toThrow();
    }
  });

  it('accepts a date that has already passed, since a programme is usually already running', () => {
    const past = new Date('2020-01-01T00:00:00Z');

    expect(currentVersion(define(withTargets([{ pillar: 'security', atLeast: 80, by: past }]), 'd1', AT, BY)).targets)
      .toEqual([{ pillar: 'security', atLeast: 80, by: past }]);
  });

  it('refuses a date that is not one', () => {
    expect(() =>
      define(withTargets([{ pillar: 'security', atLeast: 80, by: new Date('nonsense') }]), 'd1', AT, BY)
    ).toThrow(/not a date/);
  });
});

describe('revising what an assessment commits to', () => {
  const BY_DATE = new Date('2026-09-30T00:00:00Z');
  const TARGET = { pillar: 'security', atLeast: 80, by: BY_DATE };

  function committed() {
    return define({ ...DRAFT, targets: [TARGET] }, 'd1', AT, BY);
  }

  it('is a change in its own right, so moving a bar makes a version', () => {
    const revised = revise(committed(), { targets: [{ ...TARGET, atLeast: 90 }] }, LATER, BY);

    expect(revised.versions).toHaveLength(2);
    expect(currentVersion(revised).targets).toEqual([{ ...TARGET, atLeast: 90 }]);
  });

  it('refuses a revision that restates the same commitment', () => {
    expect(() => revise(committed(), { targets: [TARGET] }, LATER, BY)).toThrow(/change nothing/);
  });

  it('carries the targets forward when the revision does not mention them', () => {
    const revised = revise(committed(), { attribution: { name: 'Renamed', owners: [] } }, LATER, BY);

    expect(currentVersion(revised).targets).toEqual([TARGET]);
  });

  it('withdraws a target with an empty list, and the version before it still holds it', () => {
    const revised = revise(committed(), { targets: [] }, LATER, BY);

    expect(currentVersion(revised).targets).toBeUndefined();
    // The point of versioning them: withdrawing a commitment does not erase that it was made.
    expect(revised.versions[0]?.targets).toEqual([TARGET]);
  });

  it('refuses a revision that would drop the pillar a target is for', () => {
    // Otherwise the definition would carry a commitment about something it no longer measures, which is
    // the state `normaliseTargets` refuses on the way in. Saying which pillar beats letting the target
    // quietly stop being reportable.
    expect(() =>
      revise(
        committed(),
        { measurement: { ...DRAFT.measurement, pillars: ['cost-optimization'] } },
        LATER,
        BY
      )
    ).toThrow(/does not measure security/);
  });
});
