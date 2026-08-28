// The sentences, tested rather than read.
//
// Two of these are the reason the module exists. `duePhrase` differs by one comparison between "due
// in 12 days" and "overdue by 12 days", which mean opposite things to whoever has to act, and it is
// the kind of mistake that survives review because both branches are plausible English. And
// `standingPhrase` is the one place the app could quietly turn a board into a completion figure — the
// test holds it to leading with what calls for attention rather than with what is finished.

import { describe, expect, it } from 'vitest';
import type { ActionState } from '../api/types';
import {
  ACTION_STATES,
  AGREEMENT_DETAIL,
  AGREEMENT_LABEL,
  AGREEMENT_TONE,
  CLAIMED_WITHOUT_REQUIREMENTS,
  EFFORT_LABEL,
  LATENESS_LABEL,
  MOVE_LABEL,
  STATE_DETAIL,
  STATE_ICON,
  STATE_LABEL,
  STATE_RANK,
  STATE_TONE,
  agreementDetail,
  agreementLabel,
  dayOf,
  duePhrase,
  earliestDue,
  endOfDay,
  reasonPrompt,
  standingPhrase,
  transitionPhrase,
} from './improve-language';

const NOW = new Date('2026-03-10T09:00:00Z');

const states = (counts: Partial<Record<ActionState, number>>): Readonly<Record<ActionState, number>> => ({
  draft: 0,
  planned: 0,
  'in-progress': 0,
  blocked: 0,
  'ready-for-validation': 0,
  verified: 0,
  cancelled: 0,
  ...counts,
});

const progress = (overrides: Partial<Parameters<typeof standingPhrase>[0]> = {}) => ({
  states: states({ planned: 3 }),
  contradicted: [],
  overdue: [],
  blocked: [],
  settled: false,
  ...overrides,
});

describe('every state is named, explained, coloured and shaped', () => {
  it('covers the seven, with no state left to fall through a lookup', () => {
    for (const state of ACTION_STATES) {
      expect(STATE_LABEL[state]).toBeTruthy();
      expect(STATE_DETAIL[state]).toBeTruthy();
      expect(STATE_TONE[state]).toBeTruthy();
      expect(STATE_ICON[state]).toBeTruthy();
      expect(MOVE_LABEL[state]).toBeTruthy();
      expect(STATE_RANK[state]).toBeTypeOf('number');
    }
  });

  it('ranks a blocker above the work in progress', () => {
    // The only row on a board whose next move belongs to somebody other than the owner.
    expect(STATE_RANK.blocked).toBeLessThan(STATE_RANK['in-progress']);
    expect(STATE_RANK.verified).toBeGreaterThan(STATE_RANK.draft);
  });

  it('colours only the blocker and the verified end', () => {
    const coloured = ACTION_STATES.filter((state) => STATE_TONE[state] !== 'neutral');

    expect(coloured).toEqual(['blocked', 'verified']);
  });

  it('does not call waiting on a run "ready for validation", which invites a look for the validator', () => {
    expect(STATE_LABEL['ready-for-validation']).toBe('Waiting on a run');
  });

  it('says a run is what verifies, in the state that carries the app’s strongest claim', () => {
    expect(STATE_DETAIL.verified).toContain('run');
  });
});

describe('the two readings stay apart', () => {
  it('does not describe a claim the estate disputes as anything but still failing', () => {
    expect(AGREEMENT_LABEL.contradicted).toBe('Still failing');
  });

  it('keeps "not measured" from reading as a failure, since a blind spot is not a finding', () => {
    expect(AGREEMENT_LABEL.unmeasured).toBe('Not measured');
    expect(LATENESS_LABEL.overdue).toBe('Overdue');
  });

  it('does not tell the owner of an advice-raised action to wait for a run', () => {
    // The state's own sentence promises that the next run measures every requirement the action
    // names. An action raised from advice names none, so the promise is to a reader who would still
    // be waiting after every assessment this app can take.
    expect(STATE_DETAIL['ready-for-validation']).toContain('every requirement this names');
    expect(CLAIMED_WITHOUT_REQUIREMENTS).toContain('no assessment run can agree or disagree');
    expect(CLAIMED_WITHOUT_REQUIREMENTS).not.toContain('next run');
  });

  it('names the advisory as what settles an advice-raised claim, without predicting one', () => {
    // The other half of the same sentence. It was written when nothing settled these, and 44c gave
    // them a settler — but whether an advisory runs is somebody's schedule, so the sentence states
    // the rule and stops.
    expect(CLAIMED_WITHOUT_REQUIREMENTS).toContain('an advisory that reads the same resource');
    expect(CLAIMED_WITHOUT_REQUIREMENTS).not.toMatch(/will|next advisory/);
  });

  it('does not let an action no requirement covers read as one a run agreed with', () => {
    // An advice-raised action names no requirement, and the two wrong answers are both available:
    // "Verified" would be a claim from its owner alone, and "Not measured" would report an attempt
    // nobody made. The label says which of the two it is not, and the detail says why.
    expect(AGREEMENT_LABEL.unjudged).toBe('No requirement to judge');
    expect(AGREEMENT_DETAIL.unjudged).toContain('names no requirement');
    expect(AGREEMENT_TONE.unjudged).toBe('neutral');
  });

  it('reads an advice-raised action in the advisor’s vocabulary and not the assessment’s', () => {
    // Every sentence in `AGREEMENT_DETAIL` names a run and a requirement, and an action raised from
    // advice has neither. Rendering those there would tell a reader a requirement was measured, which
    // is a claim no field under the badge carries.
    const advised = agreementDetail({ agreement: 'agreed', controlIds: [] });

    expect(advised).toContain('advisory');
    expect(advised).not.toContain('requirement');
    expect(agreementDetail({ agreement: 'agreed', controlIds: ['DG-01-01'] })).toBe(AGREEMENT_DETAIL.agreed);
  });

  it('reads an action carrying both advice and a requirement in the assessment’s', () => {
    // The assessment is the stronger of the two readings and the one that decides the badge, so the
    // paragraph under it has to describe the same judge.
    expect(agreementDetail({ agreement: 'contradicted', controlIds: ['DG-01-01'] })).toBe(
      AGREEMENT_DETAIL.contradicted
    );
  });

  it('does not put a badge over that paragraph telling the reader to wait for a run', () => {
    // The badge is the part of the pane read first and the paragraph the part read second, so the
    // badge is where a wrong judge does the most damage. "Awaiting a run" over an action that names
    // no requirement points at a measurement that is never taken.
    expect(agreementLabel({ agreement: 'awaiting', controlIds: [] })).toBe('Awaiting an advisory');
    expect(agreementLabel({ agreement: 'awaiting', controlIds: ['DG-01-01'] })).toBe(AGREEMENT_LABEL.awaiting);
  });

  it('says the same five badges under either judge, because only one of the six names one', () => {
    // The reading is what the other five describe — "Still failing" is true whichever run took it —
    // and a second copy of them would drift a word at a time.
    for (const agreement of ['unclaimed', 'agreed', 'contradicted', 'unmeasured', 'unjudged'] as const) {
      expect(agreementLabel({ agreement, controlIds: [] })).toBe(AGREEMENT_LABEL[agreement]);
    }
  });
});

describe('a reason is asked for where the server insists on one', () => {
  it('prompts for a blocker and for a cancellation, and for nothing else', () => {
    const prompted = ACTION_STATES.filter((state) => reasonPrompt(state) != null);

    expect(prompted).toEqual(['blocked', 'cancelled']);
  });

  it('asks what the blocker is rather than for a note', () => {
    expect(reasonPrompt('blocked')).toContain('blocked on');
  });
});

describe('what a date means now', () => {
  // The counts rather than the formatted dates, which are rendered in the reader's own locale and
  // time zone. Asserting "26 Feb 2026" would pass here and fail on a machine set to en-US, and what
  // this function is at risk of getting wrong is the arithmetic and the direction, not the format.
  it('says how late, rather than only that it is late', () => {
    expect(duePhrase({ due: '2026-02-26T23:59:59.999Z', lateness: 'overdue' }, NOW)).toContain('Overdue by 11 days');
  });

  it('says how long is left, in the same shape', () => {
    expect(duePhrase({ due: '2026-03-14T23:59:59.999Z', lateness: 'due' }, NOW)).toContain('Due in 5 days');
  });

  it('reads today as today rather than as nought days', () => {
    expect(duePhrase({ due: '2026-03-10T09:00:00Z', lateness: 'overdue' }, NOW)).toContain('Was due today');
  });

  it('says an undated action cannot be planned, rather than leaving the field blank', () => {
    expect(duePhrase({ lateness: 'undated' }, NOW)).toContain('cannot be planned');
  });

  it('does not present an unreadable date as a real one', () => {
    expect(duePhrase({ due: 'the fourteenth', lateness: 'on-time' }, NOW)).toContain('could not be read');
  });

  it('keeps the calendar day chosen in a time zone east of UTC', () => {
    const previous = process.env.TZ;
    process.env.TZ = 'Australia/Brisbane';
    try {
      const expected = new Date('2026-09-30T12:00:00.000Z').toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
      expect(duePhrase({ due: '2026-09-30T23:59:59.999Z', lateness: 'on-time' }, NOW)).toBe(
        `Due ${expected}.`
      );
    } finally {
      if (previous == null) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});

describe('a plan’s rollup', () => {
  it('leads with what the estate disputes rather than with what is done', () => {
    const phrase = standingPhrase(
      progress({ states: states({ verified: 9, 'ready-for-validation': 4, planned: 1 }), contradicted: ['a', 'b'] })
    );

    // Not "9 of 14 done", which is the figure that hides these two.
    expect(phrase).toBe('2 actions still failing.');
    expect(phrase).not.toContain('9');
  });

  it('names every call on attention when there is more than one', () => {
    expect(standingPhrase(progress({ contradicted: ['a'], overdue: ['b'], blocked: ['c'] }))).toBe(
      '1 action still failing, 1 overdue, 1 blocked.'
    );
  });

  it('says nothing is late rather than implying the plan achieved something', () => {
    expect(standingPhrase(progress())).toBe('3 actions, none of them late, blocked or contradicted.');
  });

  it('claims only that every action is finished with, not that the outcome was reached', () => {
    const phrase = standingPhrase(progress({ states: states({ verified: 2, cancelled: 1 }), settled: true }));

    expect(phrase).toBe('Every one of the 3 actions is verified or cancelled.');
  });

  it('does not say "every one of the 1 actions" about a plan holding one action', () => {
    // Which is what the labs plan read, its single action having been verified by a run.
    const phrase = standingPhrase(progress({ states: states({ verified: 1 }), settled: true }));

    expect(phrase).toBe('The one action raised is verified or cancelled.');
  });

  it('says an empty plan is empty', () => {
    expect(standingPhrase(progress({ states: states({}) }))).toBe('Nothing raised against this plan yet.');
  });
});

describe('who did it', () => {
  it('names a run as a run, so a scan id is never read as a colleague', () => {
    expect(transitionPhrase({ by: 'run', who: 'scan-4f2c', at: '2026-03-09T10:00:00Z' })).toMatch(/^run scan-4f2c on /);
  });

  it('names a person as themselves', () => {
    expect(transitionPhrase({ by: 'person', who: 'ana@example.com', at: '2026-03-09T10:00:00Z' })).toMatch(
      /^ana@example\.com on /
    );
  });
});

describe('the dates a form may offer', () => {
  it('starts at tomorrow, since an action due today is late the moment it is agreed', () => {
    expect(earliestDue(NOW)).toBe('2026-03-11');
  });

  it('sends the end of the chosen day, not its start', () => {
    // A reader west of UTC picking tomorrow would otherwise send a moment already past.
    expect(endOfDay('2026-03-11')).toBe('2026-03-11T23:59:59.999Z');
  });

  it('turns a stored date back into the day a date input takes', () => {
    expect(dayOf('2026-03-11T23:59:59.999Z')).toBe('2026-03-11');
    expect(dayOf(undefined)).toBe('');
    expect(dayOf('not a date')).toBe('');
  });
});

describe('effort', () => {
  it('describes a size as people and time rather than as hours or points', () => {
    // Hours invite a schedule this app cannot keep, and points are a local currency, so a report that
    // summed them would be arithmetic on a unit that does not exist.
    for (const label of Object.values(EFFORT_LABEL)) expect(label).not.toMatch(/hour|point|day/i);
    expect(EFFORT_LABEL.programme).toBe('Programme');
  });
});
