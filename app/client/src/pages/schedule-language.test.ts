import { describe, expect, it } from 'vitest';
import type { Schedule, ScheduleRun } from '../api/types';
import {
  answersSentence,
  jobSentence,
  retryCover,
  away,
  explain,
  health,
  HEALTH_LABEL,
  identitySentence,
  inZone,
  nextSentence,
  runCaption,
  supervisionSentence,
  took,
  triggerCaption,
  WHY_A_SCHEDULE,
  withoutRepeats,
} from './schedule-language';

const NOW = new Date('2026-08-07T04:00:00Z');

function run(state: ScheduleRun['state'], over: Partial<ScheduleRun> = {}): ScheduleRun {
  return { runId: '1', state, trigger: 'schedule', ...over };
}

function schedule(over: Partial<Schedule> = {}): Schedule {
  return { state: 'live', triggerable: true, runs: [], ...over };
}

describe('whether the cadence is holding', () => {
  it('is working where it is live and the last finished run succeeded', () => {
    expect(health(schedule({ runs: [run('succeeded')] }))).toBe('working');
  });

  it('is working where it is live and nothing has run, because nothing has failed', () => {
    expect(health(schedule())).toBe('working');
  });

  it('separates failing from stopped, because the next move differs', () => {
    // Sending somebody to unpause a schedule that is already running and failing weekly is the reason
    // these are not one state.
    expect(health(schedule({ runs: [run('failed')] }))).toBe('failing');
    expect(health(schedule({ state: 'paused', runs: [run('succeeded')] }))).toBe('stopped');
    expect(HEALTH_LABEL.failing).not.toBe(HEALTH_LABEL.stopped);

    // "Running weekly" was here, and the cadence is the job's to set. The only assertion on these labels was
    // that two of them differ, so restoring the hard-coded cadence kept the suite green.
    for (const label of Object.values(HEALTH_LABEL)) expect(label).not.toMatch(/weekly|daily|monthly/i);
  });

  it('looks past a run in flight to the last one that finished', () => {
    expect(health(schedule({ runs: [run('running'), run('failed')] }))).toBe('failing');
    expect(health(schedule({ runs: [run('waiting'), run('succeeded')] }))).toBe('working');
  });

  it('does not claim to know where it could not read the job', () => {
    expect(health(schedule({ state: 'unreadable' }))).toBe('unknown');
  });

  it.each(['not-deployed', 'no-schedule', 'paused'] as const)('reads %s as stopped', (state) => {
    expect(health(schedule({ state }))).toBe('stopped');
  });
});

describe('the sentence under the heading', () => {
  /*
   * The panel's height is the runs table's room, and these sentences are most of it.
   *
   * Not a style rule. At `max-w-prose` in the panel's column each of these was four lines, the panel
   * measured 290px, and at 1280x800 that left the table 109px — room for two rows of a fitted list whose
   * floor is three, so it scrolled. Two lines is about 200 characters at that measure. What used to be
   * here is in `WHY_A_SCHEDULE`, which the disclosure below the paragraph shows.
   */
  it.each(['not-deployed', 'no-schedule', 'paused', 'live'] as const)(
    'keeps %s to about two lines, because the panel’s height is the table’s room',
    (state) => {
      for (const runs of [[], [run('failed')], [run('succeeded')]]) {
        expect(explain(schedule({ state, runs })).length).toBeLessThanOrEqual(200);
      }
    }
  );

  it('says what a not-deployed install still has, so it does not read as broken', () => {
    const words = explain(schedule({ state: 'not-deployed' }));
    expect(words).toContain('every run on this page is one somebody started');
  });

  it('says a removed schedule is an edit rather than a default', () => {
    const words = explain(schedule({ state: 'no-schedule' }));
    expect(words).toContain('bundle ships a weekly one');
    expect(words).toContain('overwritten by a deploy');
  });

  it('says how to start a paused schedule', () => {
    const words = explain(schedule({ state: 'paused' }));
    expect(words).toContain('nothing is running unattended');
    expect(words).toContain('Unpausing');
  });

  // The general half of every state's explanation, which is why the particular half can be two lines.
  it('keeps what a schedule is for out of the standing sentence and in the disclosure', () => {
    expect(WHY_A_SCHEDULE).toContain('optional half of the bundle');
    expect(WHY_A_SCHEDULE).toContain('ships paused');
    for (const state of ['not-deployed', 'no-schedule', 'paused', 'live'] as const) {
      expect(explain(schedule({ state }))).not.toContain('optional half');
    }
  });

  it('says a failing schedule stopped the history for a reason that is not the estate', () => {
    const words = explain(schedule({ runs: [run('failed')] }));
    expect(words).toContain('has stopped moving for a reason that is not the estate');
    expect(words).not.toContain('Unpausing');
  });

  // The panel stays put when the table switches views, so a sentence naming one of them is wrong on the
  // other. The links under the failure carry the direction; this paragraph must not.
  it('does not tell a reader which view to go to, because the panel appears above both', () => {
    const words = explain(schedule({ runs: [run('failed')] }));
    expect(words).not.toContain('below');
    expect(words).not.toContain('above');
  });

  it('tells a live schedule that has never fired how to find out now', () => {
    expect(explain(schedule())).toContain('Testing it now');
  });

  // A run that succeeded proves the identity could read the estate then. It does not prove the estate is
  // in the state that run reported, and the sentence must not be readable as saying so.
  it('claims only what a succeeded run proves', () => {
    const words = explain(schedule({ runs: [run('succeeded')] }));
    expect(words).toContain('as recently as that run');
    expect(words).toContain('identity it runs as');
  });

  it('passes the server sentence through where the job could not be read', () => {
    const words = explain(schedule({ state: 'unreadable', unreadable: 'the exact reason, from the server' }));
    expect(words).toBe('the exact reason, from the server');
  });
});

describe('when the next one falls', () => {
  it('says the date and how far off it is', () => {
    const words = nextSentence(schedule({ dueAt: '2026-08-10T06:00:00.000Z' }), NOW);
    expect(words).toContain('in 3 days');
  });

  it('says nothing where the schedule is not running, because nothing is due', () => {
    expect(nextSentence(schedule({ state: 'paused', dueAt: '2026-08-10T06:00:00.000Z' }), NOW)).toBeUndefined();
  });

  it('names the expression it would not read, rather than saying unknown', () => {
    const words = nextSentence(schedule({ cron: '0 0/15 * * * ?' }), NOW);
    expect(words).toContain('0 0/15 * * * ?');
    expect(words).toContain('rather say nothing than be a week out');
  });
});

describe('how far off something is', () => {
  it('uses hours up to a day and a half, then days', () => {
    expect(away(new Date('2026-08-07T04:30:00Z'), NOW)).toBe('within the hour');
    expect(away(new Date('2026-08-07T05:00:00Z'), NOW)).toBe('in 1 hour');
    expect(away(new Date('2026-08-07T14:00:00Z'), NOW)).toBe('in 10 hours');
    expect(away(new Date('2026-08-10T06:00:00Z'), NOW)).toBe('in 3 days');
  });

  it('says a date has passed rather than counting backwards', () => {
    expect(away(new Date('2026-08-01T00:00:00Z'), NOW)).toBe('which has passed');
  });
});

describe('saying a repeated failure once', () => {
  const failure = 'Task readiness failed with message: Workload failed, see run output for details.';

  it('keeps the first and drops the copies underneath it', () => {
    // Measured on the labs job: three identical full-width sentences, one per failed run, taking the
    // panel's whole height to say what one of them said.
    const shown = withoutRepeats([
      run('failed', { runId: '1', message: failure }),
      run('failed', { runId: '2', message: failure }),
      run('failed', { runId: '3', message: failure }),
    ]);

    expect(shown[0]?.message).toBe(failure);
    expect(shown[1]?.message).toBeUndefined();
    expect(shown[1]?.repeated).toBe(true);
    expect(shown[2]?.repeated).toBe(true);
  });

  it('keeps the same failure twice where a success came between them', () => {
    // Four weeks apart with a working run between is a pattern worth seeing twice. Four times running is
    // one fact.
    const shown = withoutRepeats([
      run('failed', { runId: '1', message: failure }),
      run('succeeded', { runId: '2' }),
      run('failed', { runId: '3', message: failure }),
    ]);

    expect(shown[0]?.message).toBe(failure);
    expect(shown[2]?.message).toBe(failure);
    expect(shown.some((shownRun) => shownRun.repeated === true)).toBe(false);
  });

  it('leaves runs with no message alone', () => {
    const shown = withoutRepeats([run('succeeded', { runId: '1' }), run('succeeded', { runId: '2' })]);
    expect(shown.every((shownRun) => shownRun.repeated == null)).toBe(true);
  });

  it('does not treat two different failures as a repeat', () => {
    const shown = withoutRepeats([
      run('failed', { runId: '1', message: 'the readiness task refused' }),
      run('failed', { runId: '2', message: 'the assessment ran out of time' }),
    ]);

    expect(shown[1]?.message).toBe('the assessment ran out of time');
  });
});

describe('one clock, the schedule’s own', () => {
  it('states the zone it is in, so a cadence and a due date can be compared', () => {
    // The panel says "Every Monday at 06:00 UTC" a line above. Rendering the same instant in the reader's
    // locale put "4:00:00 PM" under it on an Australian screen, and the two read as a contradiction.
    expect(inZone(new Date('2026-08-10T06:00:00Z'), 'UTC')).toContain('UTC');
    expect(inZone(new Date('2026-08-10T06:00:00Z'), 'UTC')).toContain('06:00');
  });

  it('shows a run in the schedule’s zone rather than the reader’s', () => {
    expect(runCaption(run('succeeded', { startedAt: '2026-08-10T06:00:00.000Z' }), 'UTC')).toContain('06:00 UTC');
  });

  it('carries no seconds, because a weekly cadence is not accurate to one', () => {
    expect(inZone(new Date('2026-08-10T06:00:37Z'), 'UTC')).not.toContain('37');
  });

  it('falls back to the reader’s clock for a zone the browser has never heard of', () => {
    // A `timezone_id` is a string somebody typed into a job, so this is a real input rather than a
    // defensive branch — and an empty line would be worse than a rendering that is merely not theirs.
    expect(inZone(new Date('2026-08-10T06:00:00Z'), 'Middle/Earth')).not.toBe('');
  });
});

describe('a run in a line', () => {
  it('says nothing about the trigger where the schedule did its job', () => {
    expect(triggerCaption(run('succeeded'))).toBeUndefined();
  });

  it('says so where somebody asked, or where it was a retry', () => {
    expect(triggerCaption(run('succeeded', { trigger: 'hand' }))).toBe('started by hand');
    expect(triggerCaption(run('failed', { trigger: 'retry' }))).toBe('a retry');
  });

  it('gives seconds under a minute and a half, then minutes', () => {
    expect(took(run('succeeded', { durationMs: 45_000 }))).toBe('took 45s');
    expect(took(run('succeeded', { durationMs: 492_706 }))).toBe('took 8 min');
  });

  it('says nothing about duration where there is none, which is every unfinished run', () => {
    expect(took(run('running'))).toBeUndefined();
  });

  it('mentions the attempt only above one, because the number is the signal', () => {
    expect(runCaption(run('failed', { attempt: 1 }))).not.toContain('attempt');
    expect(runCaption(run('failed', { attempt: 3 }))).toContain('attempt 3');
  });

  it('joins what it has and skips what it does not', () => {
    const caption = runCaption(run('running', { startedAt: '2026-08-07T04:18:58.000Z' }));
    // No duration, no trigger note, no attempt: one part and no stray separators.
    expect(caption).not.toContain('·');
    expect(caption).not.toBe('');
  });
});

describe('which identity a scheduled assessment measures through', () => {
  /*
   * Untested until now, which is how a fix landed on the wrong branch of it. The wording was corrected in the
   * `assessesAs == null` fallback and left in the branch that renders on a deployed bundle: `assessesAs` comes
   * from the `client_id` the bundle passes to both tasks, so the branch under test here is the rule and the
   * fallback is the exception.
   */
  const both = [
    identitySentence(schedule({ assessesAs: '4f2c-app-id', ranAs: 'someone@example.com' }), 'waf-assessment-sp'),
    identitySentence(schedule({ assessesAs: undefined, ranAs: 'someone@example.com' })),
  ];

  it('hedges a reach limit rather than asserting one, on both branches', () => {
    for (const said of both) {
      expect(said).toContain('may be a limit of that identity’s reach rather than of the estate');

      // "is usually this rather than the estate" counted nothing and attributed nothing.
      expect(said).not.toMatch(/usually|typically/);
    }
  });

  it('does not date the difference to a cadence it never read, on either branch', () => {
    // "unmeasurable on a Monday and answers on a Tuesday" reads the bundle's current cron as a fact about the
    // app. The cadence is the job's to set, and `readCadence` in `server/schedule/cron.ts` parses daily and
    // monthly too.
    for (const said of both) expect(said).not.toMatch(/Monday|Tuesday|weekly/);
  });

  it('names the assessing identity, and the notebook identity where they differ', () => {
    expect(both[0]).toContain('Assesses as waf-assessment-sp (4f2c-app-id)');
    expect(both[0]).toContain('The notebook itself runs as someone@example.com');
    expect(both[1]).toContain('Runs as someone@example.com');
  });
});

describe('what the job does about a failure', () => {
  it('says how many attempts and how far apart, in one sentence with the recipient', () => {
    const said = supervisionSentence(
      schedule({ supervision: { retries: { times: 3, waitMs: 120_000 }, notifies: ['ops@example.com'] } })
    );

    expect(said).toContain('retries itself 3 times');
    expect(said).toContain('2 minutes apart');
    expect(said).toContain('ops@example.com');
  });

  it('names the recipient rather than counting them, because the wrong address is the common defect', () => {
    // The bundle's default substitutes at deploy time to whoever deployed it, so "1 recipient" would
    // hide exactly the thing a reader needs to notice: that it is somebody who has left.
    const said = supervisionSentence(schedule({ supervision: { notifies: ['gone@example.com'] } }));

    expect(said).toContain('gone@example.com');
  });

  it('caps a long recipient list, because the paragraph sits in a measured height', () => {
    const said = supervisionSentence(
      schedule({ supervision: { notifies: ['a@b.c', 'd@e.f', 'g@h.i', 'j@k.l'] } })
    );

    // Two named and the rest counted. A job wired to a rota of fifteen would otherwise spend the runs
    // table's rows on addresses.
    expect(said).toBe('Failures are emailed to a@b.c, d@e.f and 2 others.');
  });

  it('says only that no address is set, because email is not the only way to be told', () => {
    const said = supervisionSentence(schedule({ supervision: { retries: { times: 3 } } }));

    /*
     * This said "Nobody is emailed when it fails", which is an absolute claim from a partial read: the
     * app reads the job's own `email_notifications.on_failure` and nothing else, while Databricks also
     * carries per-task email, webhooks to PagerDuty and Slack, and notification settings. The job most
     * likely to be well run — wired to an on-call rota and no address — was told nobody was watching.
     */
    expect(said).toContain('No email address is set on the job');
    expect(said).not.toContain('Nobody is emailed');
  });

  it('says an unretried failure waits for the next run, without assuming the cadence is weekly', () => {
    const said = supervisionSentence(schedule({ supervision: { retries: { times: 0 }, notifies: ['a@b.c'] } }));

    expect(said).toContain('not retried');
    // "one bad Monday is a week with no assessment in it" read the bundle's current cron as a fact about
    // the app. `readCadence` in `server/schedule/cron.ts` parses daily, weekly and monthly, so a customer on
    // a daily trigger was told they had lost a week.
    expect(said).not.toMatch(/Monday|a week with/);
  });

  it('explains that retrying a timeout rejoins the scan rather than paying for a second one', () => {
    const said = supervisionSentence(schedule({ supervision: { retries: { times: 3, onTimeout: true } } }));

    // Said because `true` reads as a duplicate bill and is not one: a retry posts the same idempotency
    // key, so it rejoins the assessment in flight. ADR 0060.
    expect(said).toContain('rejoins the scan');
  });

  it('says a timeout is not retried where the policy says so, which used to be silent', () => {
    const said = supervisionSentence(schedule({ supervision: { retries: { times: 3, onTimeout: false } } }));

    // The silence let the sentence before it stand unqualified: a reader took "retries itself 3 times" to
    // cover the run that ran out of time, which under this policy is the one failure with no second go.
    expect(said).toContain('ran out of time is not retried, so it waits for the next scheduled run');

    // The cadence too. This branch was changed in the same hunk as the one above for the same reason, and
    // only the other one got an assertion, so "a slow Monday is a week with no assessment in it" could come
    // back green.
    expect(said).not.toMatch(/Monday|a week with/);
  });

  it('says a single retry comes later rather than apart, because one gap is not two', () => {
    const said = supervisionSentence(schedule({ supervision: { retries: { times: 1, waitMs: 120_000 } } }));

    expect(said).toContain('retries itself 1 time, 2 minutes later');
    expect(said).not.toContain('apart');
  });

  it('gives a sub-minute wait in seconds, rather than rounding it up six-fold', () => {
    const said = supervisionSentence(schedule({ supervision: { retries: { times: 3, waitMs: 10_000 } } }));

    // Rounded to "about 1 minute", which overstates in the direction that has somebody wait longer than
    // they need to before looking at it.
    expect(said).toContain('about 10 seconds apart');
  });

  it('says nothing where the app could not read the job’s configuration', () => {
    expect(supervisionSentence(schedule())).toBeUndefined();
  });
});

/*
 * The paragraph the disclosure renders conditionally, and the reason it is one rather than two: a fourth
 * paragraph was measured at 472px and put the runs table under its three-row floor. These four branches
 * are what stops the panel rendering an empty paragraph or dropping a sentence.
 */
describe('the paragraph about how the job is set up', () => {
  const SUPERVISED = { supervision: { retries: { times: 3 }, notifies: ['ops@example.com'] } };

  it('joins the identity and what happens on a failure into one paragraph', () => {
    const said = jobSentence(schedule({ ranAs: 'deployer@example.com', ...SUPERVISED }));

    expect(said).toContain('Runs as deployer@example.com');
    expect(said).toContain('retries itself 3 times');
  });

  it('gives the identity alone where the app could not read what happens on a failure', () => {
    const said = jobSentence(schedule({ ranAs: 'deployer@example.com' }));

    expect(said).toContain('Runs as deployer@example.com');
    expect(said).not.toContain('retries');
  });

  it('gives the failure policy alone where there is no identity to name', () => {
    const said = jobSentence(schedule(SUPERVISED));

    expect(said).toContain('retries itself 3 times');
    expect(said).not.toContain('Runs as');
  });

  it('is absent rather than empty where there is no job to describe, so no blank paragraph renders', () => {
    // `''` from joining nothing would render an empty paragraph and spend its margin out of the budget.
    //
    // The reachable case is a job the app has not read. A live job always has the assessment sentence now,
    // whether or not it names one, because "answers to none" is the state `GAP-036` was raised about and a
    // reader cannot infer it from silence.
    expect(jobSentence(schedule({ state: 'not-deployed' }))).toBeUndefined();
    expect(jobSentence(schedule({ state: 'unreadable' }))).toBeUndefined();
  });

  it('carries which assessment the job names, after the identity and the failure policy', () => {
    const said = jobSentence(
      schedule({ ranAs: 'deployer@example.com', ...SUPERVISED, answers: { id: 'q3', name: 'Q3 review' } })
    );

    expect(said).toContain('Runs as deployer@example.com');
    expect(said).toContain('retries itself 3 times');
    expect(said).toContain('names the assessment Q3 review (q3)');
  });
});

/*
 * Which assessment an unattended run answers to, and what each branch may say about it.
 *
 * `GAP-036` asked for a target that is carried rather than resolved when the job fires. What row 55
 * measured was quieter: the job named none, so every weekly run was recorded outside every assessment.
 * These tests are as much about what the sentences do not claim — no branch predicts the next run's
 * outcome, which is the mistake `retryCover` made three times in a row on the same panel.
 */
describe('which assessment the schedule answers to', () => {
  it('names it, and says it is carried rather than looked up', () => {
    const said = answersSentence(schedule({ answers: { id: 'q3', name: 'Q3 review' } }));

    expect(said).toContain('Q3 review (q3)');
    expect(said).toContain('rather than looking one up');
  });

  it('falls back to the id where this install keeps no definitions to name it from', () => {
    const said = answersSentence(schedule({ answers: { id: 'q3' } }));

    expect(said).toContain('assessment q3');
    expect(said).not.toContain('(');
  });

  it('says the job names none rather than staying silent about it', () => {
    const said = answersSentence(schedule());

    expect(said).toContain('names no assessment');
    // The consequence, which is a fact about this app's own recording rather than a prediction.
    expect(said).toContain('answers to none');
  });

  it('says an id this install does not keep is refused, because that job fails every week', () => {
    const said = answersSentence(schedule({ answers: { id: 'deleted', missing: true } }));

    expect(said).toContain('deleted');
    expect(said).toContain('not one this install keeps');
    expect(said).toContain('refused');
  });

  it('says the same of an archived one, and why it is closed', () => {
    const said = answersSentence(schedule({ answers: { id: 'old', name: 'Last quarter', archived: true } }));

    expect(said).toContain('Last quarter');
    expect(said).toContain('archived');
    expect(said).toContain('refused');
  });

  it('reports an unsubstituted variable as one rather than as an assessment id', () => {
    const said = answersSentence(schedule({ answers: { unresolved: true } }));

    expect(said).toContain('unsubstituted bundle variable');
    // Never the template itself: a reader shown `${var.…}` as an id is being shown a bug dressed as a target.
    expect(said).not.toContain('${');
  });

  it('says nothing where the app has not read a job at all', () => {
    // "The job names no assessment" beside "no scheduled assessment is deployed here" would describe a
    // job that is not there.
    expect(answersSentence(schedule({ state: 'not-deployed' }))).toBeUndefined();
    expect(answersSentence(schedule({ state: 'unreadable' }))).toBeUndefined();
  });

  it('claims nothing about what the next run will do, in any branch', () => {
    const branches = [
      schedule(),
      schedule({ answers: { id: 'q3', name: 'Q3 review' } }),
      schedule({ answers: { id: 'q3' } }),
      schedule({ answers: { id: 'gone', missing: true } }),
      schedule({ answers: { id: 'old', name: 'Last quarter', archived: true } }),
      schedule({ answers: { unresolved: true } }),
    ];

    // The rule this panel has broken three times in three different tenses: a sentence may restate a field
    // and may not conclude what the platform is going to do with it. "will answer", "will run", "next run"
    // are all claims about a job somebody can edit between now and Monday.
    for (const one of branches) {
      const said = answersSentence(one) ?? '';
      expect(said).not.toMatch(/\bwill\b/);
      expect(said).not.toMatch(/next run/i);
    }
  });
});

/*
 * These replace three tests that asserted a defect as the specification, and then a second set that
 * asserted a different one.
 *
 * Round one: "Attempt 1 of 4, so it will try again by itself", read from `run.attempt`. All three tests
 * hand-injected attempt values the production path cannot produce, so they tested the arithmetic and nothing
 * about whether the claim was true. It never was.
 *
 * Round two: "This failure is final … its 3 retries are spent", reasoning that a run still retrying has no
 * result so `stateOf` would not call it failed. True of task retries and false of job-level ones, where a
 * retry is a new run and the original sits terminal and failed while its retry runs.
 *
 * What is tested now claims neither. It reports which step failed and whether that is the step whose policy
 * the panel quotes, and the test below pins the tense in both directions so a third attempt at deriving one
 * cannot pass quietly.
 */
describe('which step failed, and which step the quoted policy covers', () => {
  const POLICY = { supervision: { retries: { times: 3, onTimeout: true } } };

  it('says a readiness failure is outside the policy, which is the one round one got most wrong', () => {
    const said = retryCover(schedule(POLICY), run('failed', { covered: false, broke: 1 }));

    // The bundle sets that step to never retry: its answer will not change by being asked again. The first
    // version promised three more attempts on it.
    expect(said).toBe("The step that failed is not one the assessment's retry policy covers.");
  });

  it('names the step the policy covers without claiming it governed this run', () => {
    const said = retryCover(schedule(POLICY), run('failed', { covered: true, broke: 1 }));

    // Round three said "is the one that applied to it". The policy is read from the job now and the run
    // finished up to ten ticks ago, and no API field joins them, so the relationship was invented.
    expect(said).toBe("The step that failed is the assessment, which the assessment's retry policy covers.");
  });

  it('is plural when several steps broke, because `covered` is true if any of them was the assessment', () => {
    const said = retryCover(schedule(POLICY), run('failed', { covered: true, broke: 2 }));

    /*
     * Round four's defect. `coveredBy` asks every broken step whether one was the assessment, so a definite
     * singular is false on the run where two broke — a run `schedule.test.ts` constructs, and one where
     * `blamed` showed the *other* step's error directly under this sentence.
     */
    expect(said).toBe("The assessment is among the steps that failed, and the assessment's retry policy covers it.");
    expect(said).not.toContain('The step that failed is');
  });

  it('is plural in the uncovered branch too', () => {
    const said = retryCover(schedule(POLICY), run('failed', { covered: false, broke: 3 }));

    expect(said).toBe("No step that failed is one the assessment's retry policy covers.");
  });

  it('falls back to membership where the count is missing, because that is the weaker claim', () => {
    /*
     * An older server sends `covered` without `broke`. An earlier version of this test asserted the singular
     * here "because the singular claims less", which is backwards: "the step that failed is the assessment"
     * asserts both how many failed and which, where "among the steps that failed" asserts only membership and
     * holds whether one broke or three.
     */
    const said = retryCover(schedule(POLICY), run('failed', { covered: true }));

    expect(said).toBe("The assessment is among the steps that failed, and the assessment's retry policy covers it.");
    expect(said).not.toContain('The step that failed is');
  });

  it('never points the reader above, at a policy that renders collapsed and below', () => {
    const both = [
      retryCover(schedule(POLICY), run('failed', { covered: true, broke: 1 })),
      retryCover(schedule(POLICY), run('failed', { covered: false, broke: 1 })),
    ];

    // The `Disclosure` holding the policy is shut on arrival and sits under this line, so "above" sent a
    // reader to a cadence and a next-run time. Three rounds running.
    for (const said of both) expect(said).not.toMatch(/above/);
  });

  it('never leaves a bare demonstrative pointing at a policy the reader has not been shown', () => {
    for (const broke of [undefined, 1, 2]) {
      for (const covered of [true, false]) {
        const said = retryCover(schedule(POLICY), run('failed', { covered, ...(broke == null ? {} : { broke }) }));

        // "that retry policy" replaced "the retry policy above" and inherited the same emptiness: the
        // `Disclosure` holding the policy is shut on arrival, so there is no antecedent on screen. Both
        // branches name the step the policy belongs to instead.
        expect(said).not.toMatch(/that retry policy/);
      }
    }
  });

  it('never predicts a retry and never declares a failure settled, in any state it can be given', () => {
    /*
     * The regression test for both rounds at once, and it is about the tense rather than any one number.
     * Neither claim is derivable from what the app reads: the first was false on every failure the panel can
     * render, and the second on any job carrying a job-level retry policy, which the app cannot see because
     * `JobSettings` does not declare `max_retries`.
     */
    for (const covered of [true, false]) {
      for (const attempt of [undefined, 1, 2, 4, 99]) {
        for (const onTimeout of [true, false, undefined]) {
          const said = retryCover(
            schedule({ supervision: { retries: { times: 3, ...(onTimeout == null ? {} : { onTimeout }) } } }),
            run('failed', { covered, ...(attempt == null ? {} : { attempt }) })
          );

          expect(said).not.toContain('will try again');
          expect(said).not.toContain('final');
          expect(said).not.toContain('spent');
          // Nor an attempt count, which the repo's own bundle disproves: it records, measured twice on labs,
          // that the platform retries an internal error whatever the policy says.
          expect(said).not.toContain('ran once');
        }
      }
    }
  });

  it('says nothing where no step broke, or where the policy could not be read', () => {
    // Absent `covered` is a third state: a run skipped for concurrency reaches a result with nothing having
    // run, and "which step failed" has no answer when none did.
    expect(retryCover(schedule(POLICY), run('failed'))).toBeUndefined();
    expect(retryCover(schedule(), run('failed', { covered: true }))).toBeUndefined();
  });
});

describe('an unresolved bundle variable in the recipient', () => {
  it('says the deploy did not substitute it, rather than that no address is set', () => {
    const said = supervisionSentence(schedule({ supervision: { unresolved: 1 } }));

    /*
     * Filtering the `${...}` and falling through to the empty branch made this read "No email address is set
     * on the job for failures", and one *is* set — the deploy failed to resolve it.
     */
    /*
     * Whole, not by fragment. The fragment version is how "is unsubstituted bundle variable" shipped: the
     * article sat in one ternary and the noun in another, `toContain('unsubstituted bundle variable')`
     * matched the broken string, and this is the branch the repository's own bundle produces.
     */
    expect(said).toContain(
      "One failure address set on the job is an unsubstituted bundle variable, still carrying the bundle's " +
        'placeholder rather than a name.'
    );
    expect(said).not.toContain('No email address is set');
    // Round four: "so nothing is emailed" was a claim about a channel the port cannot see, on top of one
    // about what an unresolved recipient does to a notification, which nobody has observed.
    expect(said).not.toContain('nothing is emailed');
  });

  it('counts the unsubstituted addresses instead of calling them "one"', () => {
    const one = supervisionSentence(schedule({ supervision: { unresolved: 1 } }));
    const two = supervisionSentence(schedule({ supervision: { unresolved: 2 } }));

    // As a boolean this meant "one or more" and rendered "The job's only failure recipient", so a job with
    // two unsubstituted addresses was described with a number nothing had read.
    expect(one).toContain('One failure address set on the job is an unsubstituted bundle variable');
    expect(two).toContain('2 failure addresses set on the job are unsubstituted bundle variables');
    expect(two).not.toMatch(/only failure recipient|One further/);

    // The agent, too. "which the deploy should have replaced" sent a reader to look at a deploy that
    // `supervision` records as the unlikely history: a `bundle deploy` resolves `${...}` or fails, so a job
    // holding a literal template most plausibly never had one.
    for (const said of [one, two]) expect(said).not.toContain('deploy');
  });

  it('reads as English when part of the list resolved and part did not', () => {
    const said = supervisionSentence(schedule({ supervision: { notifies: ['ops@example.com'], unresolved: 1 } }));

    /*
     * Asserted whole rather than by `toContain`, which is how round three's defective version passed: every
     * fragment it checked was present in a sentence that contradicted itself.
     */
    expect(said).toContain(
      'Failures are emailed to ops@example.com. A further address set on the job is an unsubstituted ' +
        'bundle variable, so that recipient is not among them.'
    );
    expect(said).not.toContain('nothing is emailed');
  });

  it('pluralises the mixed form as well', () => {
    const said = supervisionSentence(schedule({ supervision: { notifies: ['ops@example.com'], unresolved: 2 } }));

    expect(said).toContain(
      'A further 2 addresses set on the job are unsubstituted bundle variables, so those recipients are ' +
        'not among them.'
    );
  });
});
