import { describe, expect, it } from 'vitest';
import type { SetupDraft } from '@/api/types';
import {
  SETUP_STEPS,
  describePillars,
  describePreview,
  describeSaving,
  describeSources,
  describeTargets,
  describeDay,
  listTargets,
  standingOfStep,
  stepFrom,
  troublesOn,
} from './setup-language';

const NOW = new Date('2026-08-03T12:00:00Z');

const TITLES: Readonly<Record<string, string>> = { cost: 'Cost optimisation', reliability: 'Reliability' };

function titleOf(pillarId: string): string {
  return TITLES[pillarId] ?? pillarId;
}

function draft(over: Partial<SetupDraft> = {}): SetupDraft {
  return {
    savedAt: NOW.toISOString(),
    ready: true,
    troubles: [],
    resumeAt: 'confirm',
    standing: 'new',
    ...over,
  };
}

describe('stepFrom', () => {
  it('accepts every step the wizard has', () => {
    for (const step of SETUP_STEPS) expect(stepFrom(step)).toBe(step);
  });

  /*
   * The steps are declared on both sides — five strings here and five on the server — so the case
   * that matters is a value this build does not recognise. Returning undefined rather than guessing
   * is what lets the caller resume instead of rendering a step that does not exist.
   */
  it('refuses anything else, including a step from another build', () => {
    expect(stepFrom('sources-and-policies')).toBeUndefined();
    expect(stepFrom('')).toBeUndefined();
    expect(stepFrom(null)).toBeUndefined();
    expect(stepFrom(undefined)).toBeUndefined();
  });
});

describe('standingOfStep', () => {
  it('marks a step with a trouble against it unfinished, and the rest done', () => {
    const one = draft({
      ready: false,
      troubles: [{ step: 'scope', trouble: 'Nothing says how far back this assessment looks.' }],
    });

    expect(standingOfStep(one, 'purpose')).toBe('done');
    expect(standingOfStep(one, 'scope')).toBe('unfinished');
  });

  /*
   * The third state is the point. Marking the policies step finished would claim the reader had done
   * something they have not; marking it unfinished would send the resume there forever.
   */
  it('says the policies step has nothing to fill in, whatever else is outstanding', () => {
    expect(standingOfStep(undefined, 'policies')).toBe('nothing-to-fill-in');
    expect(standingOfStep(draft({ ready: false, troubles: [] }), 'policies')).toBe('nothing-to-fill-in');
  });

  it('holds the confirmation against the whole draft rather than against a trouble of its own', () => {
    expect(standingOfStep(draft(), 'confirm')).toBe('done');
    expect(standingOfStep(draft({ ready: false }), 'confirm')).toBe('unfinished');
  });

  it('treats nothing written yet as nothing finished', () => {
    expect(standingOfStep(undefined, 'purpose')).toBe('unfinished');
  });
});

describe('troublesOn', () => {
  it('is the server’s own sentences, for that step alone', () => {
    const one = draft({
      ready: false,
      troubles: [
        { step: 'purpose', trouble: 'No name.' },
        { step: 'scope', trouble: 'No lookback.' },
        { step: 'scope', trouble: 'No workspaces.' },
      ],
    });

    expect(troublesOn(one, 'scope')).toEqual(['No lookback.', 'No workspaces.']);
    expect(troublesOn(one, 'sources')).toEqual([]);
    expect(troublesOn(undefined, 'scope')).toEqual([]);
  });
});

describe('describeSaving', () => {
  /*
   * The pairing is the whole reason this is one sentence. A wizard that autosaves and says so trains
   * a reader to stop worrying about losing their work, and on an install with nothing bound to keep
   * drafts in that training is exactly wrong.
   */
  it('says a durable draft can be left, and an in-memory one cannot', () => {
    const state = { savedAt: NOW.toISOString(), saving: false };

    expect(describeSaving(state, true, NOW)).toContain('come back to it');
    expect(describeSaving(state, false, NOW)).toContain('in memory only');
  });

  it('names the failure rather than claiming a save that did not happen', () => {
    const said = describeSaving({ saving: false, error: 'You may not write here.' }, true, NOW);
    expect(said).toBe('Not saved. You may not write here.');
  });

  it('counts from when it was kept', () => {
    const minutes = (count: number) => new Date(NOW.getTime() - count * 60_000).toISOString();

    expect(describeSaving({ savedAt: minutes(0), saving: false }, true, NOW)).toContain('a moment ago');
    expect(describeSaving({ savedAt: minutes(1), saving: false }, true, NOW)).toContain('1 minute ago');
    expect(describeSaving({ savedAt: minutes(9), saving: false }, true, NOW)).toContain('9 minutes ago');
    expect(describeSaving({ savedAt: minutes(120), saving: false }, true, NOW)).toContain('2 hours ago');
  });

  it('warns before anything is written on an install that keeps nothing', () => {
    expect(describeSaving({ saving: false }, false, NOW)).toContain('finish in one sitting');
    expect(describeSaving({ saving: false }, true, NOW)).toContain('as soon as you type');
  });
});

describe('describePillars', () => {
  /*
   * An absent list means every pillar, exactly as it does on a definition, and the two states an
   * author can be in are "all of it" and "these four" — only one of which is a list.
   */
  it('reads an absent list as every pillar', () => {
    expect(describePillars(undefined, 7)).toContain('all 7');
  });

  it('names an empty list as the mistake it is', () => {
    expect(describePillars([], 7)).toContain('not an assessment');
  });

  it('says a list of everything means the same as no list', () => {
    expect(describePillars(['a', 'b'], 2)).toContain('same thing as choosing none');
  });

  it('says what is left out when some are', () => {
    expect(describePillars(['a', 'b'], 7)).toBe('2 pillars of 7. The rest are not measured and are not scored.');
  });
});

describe('describeSources', () => {
  function pillar(over: Partial<Parameters<typeof describeSources>[0]> = {}) {
    return {
      signals: [],
      answeredControls: 0,
      unanswered: { attestation: 0, unreachable: 0, planned: 0, unimplemented: 0 },
      ...over,
    };
  }

  /*
   * Tables and endpoints are counted apart because they are two different grants to ask for, and the
   * plan itself makes the distinction: an endpoint is written as a path.
   */
  it('counts system tables and endpoints separately, and each one once', () => {
    const said = describeSources(
      pillar({
        answeredControls: 4,
        signals: [
          { touches: ['system.billing.usage', 'system.billing.usage', '/api/2.0/settings'] },
          { touches: ['system.access.audit'] },
        ],
      })
    );

    expect(said).toContain('2 system tables');
    expect(said).toContain('1 endpoint');
    expect(said).toContain('4 requirements');
  });

  it('says so plainly when nothing here is read automatically', () => {
    expect(
      describeSources(pillar({ unanswered: { attestation: 9, unreachable: 0, planned: 0, unimplemented: 0 } }))
    ).toBe('Nothing here is read automatically. Beside that: 9 requirements only a person can answer.');
  });

  it('keeps the three kinds of unanswered apart, because they are three different problems', () => {
    const said = describeSources(
      pillar({
        signals: [{ touches: ['system.a.b'] }],
        answeredControls: 1,
        unanswered: { attestation: 2, unreachable: 1, planned: 1, unimplemented: 2 },
      })
    );

    expect(said).toContain('2 requirements only a person can answer');
    expect(said).toContain('1 requirement no install of this app is allowed to read');
    expect(said).toContain('3 requirements with no check yet');
  });
});

describe('describePreview', () => {
  /*
   * The server's description is the authority. What this adds is the case the server cannot describe,
   * where the empty lists mean "not known" rather than "nothing" — and a reader told "0 workspaces"
   * for an unresolved scope would act on a number that is not a measurement.
   */
  it('defers to the server, and prefers its reason for having no answer', () => {
    expect(
      describePreview({ assessed: [], omitted: [], outOfScope: 0, complete: true, description: 'Covers 4.' })
    ).toBe('Covers 4.');
    expect(
      describePreview({
        assessed: [],
        omitted: [],
        outOfScope: 0,
        complete: false,
        description: 'Not known.',
        unavailable: 'No scan has run yet.',
      })
    ).toBe('No scan has run yet.');
  });

  it('invites a scope rather than reporting one when nothing has been asked', () => {
    expect(describePreview(undefined)).toContain('Choosing a scope');
  });
});

describe('describeTargets', () => {
  /*
   * Said in words rather than left blank. The strip ticks a step with no troubles on it, and this
   * step has none when nothing is committed to — so without a sentence saying that is allowed, a
   * tick beside an empty commitment reads as one that was made.
   */
  it('says committing to nothing is allowed', () => {
    for (const targets of [undefined, [], [{ pillar: '  ' }]]) {
      expect(describeTargets(targets)).toContain('Nothing committed to');
      expect(describeTargets(targets)).toContain('allowed');
    }
  });

  it('counts the whole ones and names the nearest', () => {
    const said = describeTargets(
      [
        { pillar: 'cost', atLeast: 70, by: '2027-03-31' },
        { pillar: 'reliability', atLeast: 80, by: '2026-12-31' },
      ],
      titleOf
    );
    expect(said).toContain('2 commitments');
    expect(said).toContain('Reliability');
    expect(said).toContain('80');
    expect(said).not.toContain('Cost optimisation');
  });

  /*
   * The catalogue's title, not the id it is stored under. `cost-optimization` in a sentence about a
   * promise somebody is making is the app showing its internals at the worst possible moment.
   */
  it('names the pillar the way the rest of the app does', () => {
    const said = describeTargets(
      [
        { pillar: 'cost', atLeast: 70, by: '2026-12-31' },
        { pillar: 'reliability', atLeast: 80, by: '2027-03-31' },
      ],
      titleOf
    );
    expect(said).toContain('Cost optimisation');
    expect(said).not.toContain('cost ');
  });

  it('counts one as one', () => {
    expect(describeTargets([{ pillar: 'cost', atLeast: 70, by: '2027-03-31' }], titleOf)).toContain('1 commitment.');
  });

  /*
   * With one commitment the row saying the same thing sits directly under this sentence, and "the
   * nearest is" reads as though a second one is being kept somewhere the reader cannot see.
   */
  it('does not point at the nearest when there is only one', () => {
    expect(describeTargets([{ pillar: 'cost', atLeast: 70, by: '2027-03-31' }], titleOf)).not.toContain('nearest');
  });

  /*
   * A half-written row is what makes the step unfinished, and the trouble beside it already names the
   * pillar and what is missing. This says how many there are so the count is not silently wrong, and
   * leaves the diagnosis to the one place that has it.
   */
  it('does not count a half-written row among the commitments, and says it is there', () => {
    const said = describeTargets([
      { pillar: 'cost', atLeast: 70, by: '2027-03-31' },
      { pillar: 'reliability', atLeast: 80 },
    ]);
    expect(said).toContain('1 commitment.');
    expect(said).toContain('1 other still half-written');
  });

  it('says so when everything started is half-written, rather than claiming a commitment', () => {
    const said = describeTargets([{ pillar: 'cost', atLeast: 70 }, { pillar: 'reliability', by: '2026-12-31' }]);
    expect(said).toContain('2 commitments started, none of them finished');
  });
});

describe('describeDay', () => {
  it('reads a date the author typed as a day', () => {
    expect(describeDay('2026-12-31')).toContain('2026');
  });

  /*
   * The last day of a year is the case that catches a zone bug: parsed as local midnight and printed
   * in a zone behind UTC, 31 December is shown as 30 December, and the commitment appears to be a day
   * earlier than the one that was made.
   */
  it('names the day that was typed, not the day before it', () => {
    expect(describeDay('2026-12-31')).toContain('31');
    expect(describeDay('2027-01-01')).toContain('2027');
  });

  /*
   * `new Date` reads a half-typed 2026-1 as the first of January. Printing that would show the author
   * a day they have not chosen yet as though they had. The field on the step is where an incomplete
   * date gets complained about.
   */
  it('passes through anything that is not a whole date, rather than guessing at it', () => {
    expect(describeDay('2026-1')).toBe('2026-1');
    expect(describeDay('2026')).toBe('2026');
    expect(describeDay('')).toBe('');
    expect(describeDay('2026-13-40')).toBe('2026-13-40');
  });
});

describe('listTargets', () => {
  /*
   * The confirmation is the last thing read before the button, and its job is to say what is about to
   * be recorded. "1 commitment" is the one fact about a commitment that leaves out the commitment,
   * which is why the confirmation lists rather than summarises.
   */
  it('states each commitment, with the pillar, the score and the day', () => {
    const lines = listTargets([{ pillar: 'cost', atLeast: 80, by: '2027-03-31' }], titleOf);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Cost optimisation');
    expect(lines[0]).toContain('80');
    expect(lines[0]).toContain('2027');
  });

  it('keeps the order the author wrote them in', () => {
    const lines = listTargets(
      [
        { pillar: 'reliability', atLeast: 80, by: '2027-03-31' },
        { pillar: 'cost', atLeast: 70, by: '2026-12-31' },
      ],
      titleOf
    );
    expect(lines[0]).toContain('Reliability');
    expect(lines[1]).toContain('Cost optimisation');
  });

  /*
   * Named rather than dropped. An author who typed a score and never came back needs to learn here
   * that it will not be recorded, rather than find it missing from the version afterwards.
   */
  it('says a half-written one will not be recorded, rather than omitting it', () => {
    const lines = listTargets([{ pillar: 'cost', atLeast: 80 }], titleOf);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Cost optimisation');
    expect(lines[0]).toContain('will not be recorded');
  });

  it('has nothing to list when nothing was written', () => {
    expect(listTargets(undefined, titleOf)).toEqual([]);
    expect(listTargets([], titleOf)).toEqual([]);
    expect(listTargets([{ pillar: '  ' }], titleOf)).toEqual([]);
  });
});
