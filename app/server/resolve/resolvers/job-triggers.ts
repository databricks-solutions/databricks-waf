// Two job-trigger questions the jobs inventory already answers directly.
//
// `trigger_type` and `health_rules` are both recorded per job, and each of these was a
// question asking a person to describe a fact the platform already states. Neither reads
// cleanly as a share of the whole estate, though: most jobs have nothing to do with files,
// and most are not streaming, so both resolvers scope their population to the jobs the field
// itself puts in scope rather than to every job collected.

import type { ControlResolver } from '../resolver.js';
import { asJob } from '../locate.js';
import type { JobRow } from '../../collect/sql/shapes.js';
import { share } from '../../collect/sql/rows.js';
import {
  bandOutcome,
  bandsOf,
  evidenceFrom,
  fromSignal,
  notApplicable,
  offenders,
  percent,
  triggerMechanismRecorded,
  unmeasured,
} from './helpers.js';

const JOBS = 'sql:jobs.inventory';

/**
 * OE-02-05: file ingestion reacting to arrival, rather than polling a schedule.
 *
 * `trigger_type` is `FILE_ARRIVAL` for a job that reacts to a new file, and `PERIODIC` or
 * `CRON` for one that polls on an interval or a cron expression — the platform's own record
 * of exactly the choice this control asks about. Read for what it can prove rather than
 * banded into a share: a periodic job may have nothing to do with files at all, and nothing
 * here says which of them do. A file-arrival trigger existing anywhere in the estate is
 * direct evidence the mechanism is in use; none existing is not evidence that ingestion polls
 * for files, since the estate may run no file ingestion, or run it continuously through Auto
 * Loader outside a schedule entirely.
 */
const fileArrivalIngestion = fromSignal<JobRow[]>(JOBS, ['OE-02-05'], (jobs, context) => {
  // Said before anything is counted, because every sentence below is about the jobs that exist and
  // none of them is true of none. An estate with no job definitions has no ingestion to schedule.
  if (jobs.length === 0) {
    return notApplicable(
      'This estate has no job definitions, so there is no scheduled ingestion here to react to a file or to ' +
        'poll for one. Work running only in interactive notebooks would not appear here.'
    );
  }

  /*
   * Two ways a row cannot name the mechanism, and this control needs the mechanism.
   *
   * A definition from before the trigger columns were written carries nothing. A definition with two or
   * more triggers carries `MULTIPLE` and a null struct, with the set in a `triggers` array this
   * statement does not project — and one of those triggers may well be the file arrival this control is
   * looking for. Both are unread here; neither is evidence of absence.
   */
  const readable = jobs.filter((job) => triggerMechanismRecorded(job));
  const unreadable = jobs.length - readable.length;
  const fileArrival = readable.filter((job) => job.triggerType === 'FILE_ARRIVAL');
  const polling = readable.filter((job) => job.triggerType === 'PERIODIC' || job.triggerType === 'CRON');
  // Noun and verb kept together: one job *has* no trigger this reading can name, several *have* none,
  // and the count that decides which is the same one printed. Agreeing them separately is how "1 job
  // have" reached a finding a customer reads.
  const unreadableNoun = `${unreadable.toLocaleString('en-US')} job${unreadable === 1 ? '' : 's'}`;
  const unreadableVerb = unreadable === 1 ? 'has' : 'have';
  const unnamed = 'no trigger this reading can name — either the definition records none, or it records more than one';

  // A file-arrival trigger settles this whichever way the rest of the estate reads, so the
  // unreadable definitions are named beside the pass rather than blocking it.
  if (fileArrival.length > 0) {
    return {
      outcome: 'pass' as const,
      evidence: [
        evidenceFrom(
          context,
          JOBS,
          `${fileArrival.length.toLocaleString('en-US')} job${fileArrival.length === 1 ? '' : 's'} triggered by file arrival` +
            (polling.length > 0
              ? `, against ${polling.length.toLocaleString('en-US')} on a periodic or cron schedule`
              : '') +
            (unreadable > 0 ? `; ${unreadableNoun} ${unreadableVerb} ${unnamed}` : ''),
          'File ingestion reacts to a file arriving rather than polling a schedule to check'
        ),
      ],
    };
  }

  if (polling.length > 0) {
    return unmeasured(
      `${polling.length.toLocaleString('en-US')} job${polling.length === 1 ? '' : 's'} run on a periodic or cron ` +
        'schedule and no job whose trigger this reading can name is triggered by file arrival. `trigger_type` ' +
        'records the mechanism a job uses to start, not what the job does once it runs, so this cannot say ' +
        'whether any of those jobs is polling for a file that may or may not have landed, or doing something with ' +
        'no file in it at all. A file-arrival trigger anywhere in the estate would settle this measure toward a ' +
        'pass; none existing does not settle it toward a fail.' +
        (unreadable > 0 ? ` A further ${unreadableNoun} ${unreadableVerb} ${unnamed}.` : ''),
      'attestation'
    );
  }

  /*
   * Nothing named in either bucket. Which of the two answers that gets depends on whether the estate
   * said so or the row declined to: a definition predating the trigger columns carries nothing, and one
   * recording several triggers keeps them in a column this statement does not read. An exclusion over
   * either would report this app's reach as a fact about how the estate ingests files. Only an estate
   * whose triggers were all named, and all something else, is genuinely outside this question.
   */
  if (unreadable > 0) {
    return unmeasured(
      `${unreadableNoun} of ${jobs.length.toLocaleString('en-US')} ${unreadableVerb} ${unnamed}, and no job that ` +
        'records one is on a file-arrival, periodic or cron trigger. So whether anything here reacts to a file ' +
        'arriving is unknown rather than absent.',
      'attestation'
    );
  }

  return notApplicable(
    'Every job in this estate records a single trigger, and none of those is a file arrival or a periodic or cron ' +
      'schedule, so the choice between reacting to a file and polling for one does not arise here. A job on some ' +
      'other trigger — continuous, a table update, another job — is answering a different question than this one.'
  );
});

/**
 * PE-05-03: streaming backlog alerting.
 *
 * Scoped to jobs on a continuous trigger, which is the mechanism a job stays running under in
 * Lakeflow Jobs — the platform's own marker for "this keeps going" rather than a batch run that
 * finishes. A batch job's health rules answer OE-04-01 already; this asks the narrower question
 * of whether a rule watching backlog specifically (`STREAMING_BACKLOG_*`) exists on the jobs that
 * do not stop, which is what tells someone lag is growing before a deadline it is meant to meet
 * is missed.
 */
const streamBacklogAlerting = fromSignal<JobRow[]>(JOBS, ['PE-05-03'], (jobs, context) => {
  if (jobs.length === 0) {
    return notApplicable(
      'This estate has no job definitions, so nothing here runs continuously for a backlog alert to watch. A ' +
        'streaming query in an interactive notebook would not appear here.'
    );
  }

  const continuous = jobs.filter((job) => job.continuous === true);
  if (continuous.length === 0) {
    /*
     * `continuous` is read from the `trigger` struct, which is null both on a definition predating the
     * column and on one with several triggers — where a continuous trigger may be among the set, in the
     * array this statement does not read. An absent flag is therefore not an absent streaming workload,
     * and excluding the control over either would claim there is nothing to watch on the strength of a
     * field that did not answer.
     */
    const unreadable = jobs.filter((job) => !triggerMechanismRecorded(job)).length;
    if (unreadable > 0) {
      return unmeasured(
        `No job here records a continuous trigger, and ${unreadable.toLocaleString('en-US')} of ` +
          `${jobs.length.toLocaleString('en-US')} ${unreadable === 1 ? 'records' : 'record'} no trigger this ` +
          'reading can name — either the definition records none, or it records more than one and the set is not ' +
          'in this reading. Whether this estate runs a streaming job is unknown rather than settled, so whether ' +
          'one needs a backlog alert is unread.',
        'attestation'
      );
    }

    return notApplicable(
      'Every job in this estate records a single trigger and none of them is continuous, which is the mechanism a ' +
        'streaming job stays running under. There is no streaming workload here for a backlog alert to watch.'
    );
  }

  const known = continuous.filter((job) => job.healthRulesKnown);
  if (known.length === 0) {
    return unmeasured(
      `${continuous.length.toLocaleString('en-US')} continuous job${continuous.length === 1 ? '' : 's'} found, ` +
        'but none carries a readable health-rules list — the column is unpopulated for definitions not edited ' +
        'since early December 2025. Whether any of them alerts on backlog is unknown rather than absent.',
      'attestation'
    );
  }

  const monitored = known.filter((job) => job.hasStreamBacklogRule);
  const unmonitored = known.filter((job) => !job.hasStreamBacklogRule);
  const adopted = share(monitored.length, known.length);
  const unknown = continuous.length - known.length;

  return {
    outcome: bandOutcome(adopted, bandsOf(context.spec, { pass: 0.8, partial: 0.3 })),
    evidence: [
      evidenceFrom(
        context,
        JOBS,
        `${monitored.length} of ${known.length} continuous jobs with a readable health-rules list carry a ` +
          `streaming-backlog rule (${percent(adopted)})` +
          (unknown > 0
            ? `; ${unknown.toLocaleString('en-US')} more have no readable health-rules list and are left out of the share`
            : ''),
        'Every continuous job carries a health rule watching streaming backlog'
      ),
      ...offenders(context, JOBS, 'Running without a backlog alert', unmonitored, asJob),
    ],
    outcomeReason:
      'A backlog rule (`STREAMING_BACKLOG_BYTES`, `_RECORDS`, `_SECONDS` or `_FILES`) is the platform’s own ' +
      'mechanism for surfacing growing lag before a deadline is missed; a duration or failure rule alone does ' +
      'not watch for it. Measured only over continuous jobs whose health rules the system table records.' +
      (unknown > 0
        ? ` ${unknown.toLocaleString('en-US')} continuous job${unknown === 1 ? '' : 's'} predate the health-rules ` +
          'column and are excluded from the ratio rather than assumed either way.'
        : ''),
  };
});

export const JOB_TRIGGERS_RESOLVERS: readonly ControlResolver[] = [fileArrivalIngestion, streamBacklogAlerting];
