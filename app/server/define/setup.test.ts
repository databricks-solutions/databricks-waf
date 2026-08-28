import { describe, expect, it } from 'vitest';
import { define, revise, archive, type AssessmentDefinition, type Draft } from './definition.js';
import { SETUP_STEPS, ready, resumeAt, standingOf, troubles, type SetupDraft } from './setup.js';

const AT = new Date('2026-08-03T09:00:00Z');
const LATER = new Date('2026-08-04T09:00:00Z');
const BY = 'alice@example.com';

function draft(fields: Partial<SetupDraft> = {}): SetupDraft {
  return { author: BY, savedAt: AT, ...fields };
}

/** A draft with nothing left to fix, so a test about one field is about that field alone. */
function complete(fields: Partial<SetupDraft> = {}): SetupDraft {
  return draft({
    name: 'Q3 platform review',
    scope: { kind: 'account' },
    lookbackDays: 30,
    ...fields,
  });
}

const DEFINITION: Draft = {
  measurement: { scope: { kind: 'account' }, lookbackDays: 30 },
  attribution: { name: 'Q3 platform review', owners: [BY] },
};

function stored(): AssessmentDefinition {
  return define(DEFINITION, 'd1', AT, BY);
}

describe('what is left to fix', () => {
  it('names the steps in the order they are asked, so a resume lands on the earliest one', () => {
    expect([...SETUP_STEPS]).toEqual(['purpose', 'scope', 'sources', 'targets', 'policies', 'confirm']);
  });

  it('an empty draft is short of a name, a scope and a lookback', () => {
    const found = troubles(draft());
    expect(found.map((one) => one.step)).toEqual(['purpose', 'scope', 'scope']);
    expect(ready(draft())).toBe(false);
  });

  it('a name of only spaces is no name', () => {
    expect(troubles(complete({ name: '   ' })).map((one) => one.step)).toEqual(['purpose']);
  });

  it('narrowing to no workspaces is refused here rather than at the end', () => {
    const found = troubles(complete({ scope: { kind: 'selected', workspaceIds: [] } }));
    expect(found).toHaveLength(1);
    expect(found[0]?.trouble).toContain('would measure nothing');
  });

  it('a scope of chosen workspaces with one chosen is finished', () => {
    expect(ready(complete({ scope: { kind: 'selected', workspaceIds: ['w1'] } }))).toBe(true);
  });

  /*
   * The bounds are the domain's, not looser ones. A draft that passes here and is refused by
   * `normalise` on confirm would put the refusal after the author had re-read every step, which is
   * the failure a draft exists to stop.
   */
  it.each([0, 366, 30.5, Number.NaN])('a lookback of %s is refused', (lookbackDays) => {
    const found = troubles(complete({ lookbackDays }));
    expect(found.map((one) => one.step)).toEqual(['scope']);
    expect(found[0]?.trouble).toContain('between 1 and 365');
  });

  it.each([1, 30, 365])('a lookback of %i is allowed', (lookbackDays) => {
    expect(ready(complete({ lookbackDays }))).toBe(true);
  });

  it('an empty pillar list is refused, because the shape already says "all of them" by saying nothing', () => {
    const found = troubles(complete({ pillars: [] }));
    expect(found.map((one) => one.step)).toEqual(['sources']);
  });

  it('no pillar list at all is every pillar, and finished', () => {
    expect(ready(complete())).toBe(true);
  });
});

describe('what is left to fix about the commitments', () => {
  /*
   * Committing to nothing is the ordinary case, and the whole step is optional. A wizard that
   * blocked on an empty targets list would make every assessment carry a promise its author never
   * intended to make.
   */
  it('no targets at all is finished', () => {
    expect(ready(complete())).toBe(true);
    expect(ready(complete({ targets: [] }))).toBe(true);
  });

  it('an empty row is somebody who opened the step and typed nothing, not a mistake', () => {
    expect(ready(complete({ targets: [{ pillar: '' }] }))).toBe(true);
  });

  it.each([
    ['a score with no date', { pillar: 'cost', atLeast: 80 }],
    ['a date with no score', { pillar: 'cost', by: '2026-12-31' }],
    ['a date typed as empty', { pillar: 'cost', atLeast: 80, by: '' }],
  ])('%s is half a target', (_what, target) => {
    const found = troubles(complete({ pillars: ['cost'], targets: [target] }));
    expect(found.map((one) => one.step)).toEqual(['targets']);
    expect(found[0]?.trouble).toContain('cost');
    expect(found[0]?.trouble).toContain('half a target');
  });

  it('both halves and a measured pillar is finished', () => {
    expect(ready(complete({ pillars: ['cost'], targets: [{ pillar: 'cost', atLeast: 80, by: '2026-12-31' }] }))).toBe(
      true
    );
  });

  /*
   * Named rather than counted, because the usual cause is dropping a pillar on the sources step and
   * forgetting the commitment left behind, and the fix is to look at that one row.
   */
  it('a target for a pillar this assessment does not cover could never be reported against', () => {
    const found = troubles(
      complete({ pillars: ['cost'], targets: [{ pillar: 'reliability', atLeast: 80, by: '2026-12-31' }] })
    );
    expect(found.map((one) => one.step)).toEqual(['targets']);
    expect(found[0]?.trouble).toContain('reliability');
    expect(found[0]?.trouble).toContain('not in this assessment');
  });

  it('says nothing about coverage when the assessment covers every pillar', () => {
    expect(ready(complete({ targets: [{ pillar: 'anything', atLeast: 80, by: '2026-12-31' }] }))).toBe(true);
  });

  it('two commitments to one pillar is one of them being unmeant', () => {
    const found = troubles(
      complete({
        pillars: ['cost'],
        targets: [
          { pillar: 'cost', atLeast: 80, by: '2026-12-31' },
          { pillar: 'cost', atLeast: 90, by: '2027-06-30' },
        ],
      })
    );
    expect(found.map((one) => one.step)).toEqual(['targets']);
    expect(found[0]?.trouble).toContain('more than one target');
  });

  it('names all of a few and counts many, so the message stays readable', () => {
    const half = (pillar: string) => ({ pillar, atLeast: 80 });
    const two = troubles(complete({ pillars: ['a', 'b'], targets: [half('a'), half('b')] }));
    expect(two[0]?.trouble).toContain('a and b');

    const four = troubles(
      complete({ pillars: ['a', 'b', 'c', 'd'], targets: [half('a'), half('b'), half('c'), half('d')] })
    );
    expect(four[0]?.trouble).toContain('4 pillars');
  });

  it('puts the author back on the commitments when that is the first thing left', () => {
    expect(resumeAt(complete({ pillars: ['cost'], targets: [{ pillar: 'cost', atLeast: 80 }] }))).toBe('targets');
  });
});

describe('where the author is put back', () => {
  it('on the first step that is not finished', () => {
    expect(resumeAt(draft())).toBe('purpose');
    expect(resumeAt(draft({ name: 'Named' }))).toBe('scope');
    expect(resumeAt(complete({ pillars: [] }))).toBe('sources');
  });

  it('on the confirmation when there is nothing left', () => {
    expect(resumeAt(complete())).toBe('confirm');
  });

  /*
   * The policies step has no field on it, so it can never be the answer. Being taken to a page with
   * nothing to do and told that is where the work stopped would be a lie about why you are there.
   */
  it('never on the policies step', () => {
    for (const fields of [{}, { name: 'Named' }, { pillars: [] as string[] }]) {
      expect(resumeAt(draft(fields))).not.toBe('policies');
    }
  });
});

describe('whether the assessment is still the one this was started against', () => {
  it('a draft of a new assessment has nothing to be stale against', () => {
    const { standing, warning } = standingOf(draft(), undefined);
    expect(standing).toBe('new');
    expect(warning).toBeUndefined();
  });

  it('a revision from the current version is current', () => {
    const { standing, warning } = standingOf(draft({ definitionId: 'd1', fromVersion: 1 }), stored());
    expect(standing).toBe('current');
    expect(warning).toBeUndefined();
  });

  /*
   * The reason this function exists. The routes already refuse this revision with a 409 — but they
   * refuse it after the author has pressed the last button, and by then they have re-read a scope
   * they are about to be told is out of date.
   */
  it('a revision somebody else has already superseded says who, before anything is re-read', () => {
    const revised = revise(stored(), { attribution: { name: 'Renamed by Bob', owners: [] } }, LATER, 'bob@example.com');
    const { standing, warning } = standingOf(draft({ definitionId: 'd1', fromVersion: 1 }), revised);

    expect(standing).toBe('superseded');
    expect(warning).toContain('version 2 is now current');
    expect(warning).toContain('bob@example.com');
  });

  it('a draft carrying an id but no version is treated as stale rather than as safe', () => {
    expect(standingOf(draft({ definitionId: 'd1' }), stored()).standing).toBe('superseded');
    expect(standingOf(draft({ definitionId: 'd1' }), stored()).warning).toContain('an unrecorded version');
  });

  it('an archived assessment cannot take another version, and the draft is offered as a new one', () => {
    const { standing, warning } = standingOf(draft({ definitionId: 'd1', fromVersion: 1 }), archive(stored(), LATER));
    expect(standing).toBe('archived');
    expect(warning).toContain('saved as a new assessment');
  });

  /*
   * A definition that has gone and an install that lost its database look identical from here, so
   * the warning says both rather than picking the one that sounds better.
   */
  it('an assessment that is no longer in the store does not guess why', () => {
    const { standing, warning } = standingOf(draft({ definitionId: 'd1', fromVersion: 1 }), undefined);
    expect(standing).toBe('gone');
    expect(warning).toContain('lost the database');
  });
});
