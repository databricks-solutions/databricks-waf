// The words the improvement surface uses, in one place.
//
// Separated from the components like the other language modules, and with one extra reason of its
// own: an action carries two readings that are easy to collapse into one sentence and must not be.
// Agreement is what the estate says about the work; lateness is where the date sits. "Overdue" and
// "the last run still says this is failing" are different problems with different next actions, and a
// single phrase covering both would be wrong about one of them on every row it appeared on.
//
// Nothing here claims an action changed a score. Planning to fix a requirement does not fix it, and
// a board of well-specified actions sitting beside a rising number would be read as the cause of it.

import {
  CalendarClock,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleMinus,
  CircleSlash,
  CircleX,
  Hourglass,
  Octagon,
  PencilLine,
  Play,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import type { ActionEffort, ActionPriority, ActionState, Agreement, ImprovementAction, Lateness } from '../api/types';
import type { Tone } from '../components/ui/StatusBadge';

export const ACTION_STATES: readonly ActionState[] = [
  'draft',
  'planned',
  'in-progress',
  'blocked',
  'ready-for-validation',
  'verified',
  'cancelled',
];

/**
 * What each state is called on a board.
 *
 * `ready-for-validation` reads as "Waiting on a run" rather than as the record's own word, because
 * the record's word invites the reader to look for the person who validates. Nobody does: the next
 * run either agrees or does not.
 */
export const STATE_LABEL: Readonly<Record<ActionState, string>> = {
  draft: 'Draft',
  planned: 'Planned',
  'in-progress': 'In progress',
  blocked: 'Blocked',
  'ready-for-validation': 'Waiting on a run',
  verified: 'Verified',
  cancelled: 'Cancelled',
};

/**
 * What being in each state means, for the pane where there is room to say it.
 *
 * `verified` says that a run agreed and leaves what the estate says now to `AGREEMENT_DETAIL`, which
 * is the pane beneath it. The two are not the same sentence for the case that matters: an action a run
 * agreed with in June, whose requirement fails in July, stays verified and reads contradicted. Saying
 * the measurement twice made the ordinary case stutter and the interesting case ambiguous about which
 * of the two panes was the current one.
 */
export const STATE_DETAIL: Readonly<Record<ActionState, string>> = {
  draft: 'Being written. Nobody has taken this on, and it is not counted as agreed work.',
  planned: 'Agreed, with an owner, a definition of done and a date. Not started.',
  'in-progress': 'Somebody is doing it.',
  blocked: 'Stopped on something outside the owner’s control, with the reason recorded below.',
  'ready-for-validation':
    'The owner says the work is done. The next run either measures every requirement this names as met, ' +
    'and it becomes verified, or it does not and this says so.',
  verified:
    'A run agreed with the owner’s claim, on the date in the trail below. This records that it ' +
    'happened, and not that the estate still reads that way today.',
  cancelled: 'Decided against, with a reason. Kept, because somebody considered it.',
};

/**
 * What `ready-for-validation` means on an action that names no requirement.
 *
 * The sentence above it is false for one: there is no requirement for a run to measure, so it cannot
 * become verified and cannot be told it did not. Saying "the next run either measures every
 * requirement this names" of an action naming none is the kind of sentence a reader waits on.
 *
 * What settles it is named, as the app's own rule rather than as a prediction: an advisory that reads
 * the same resource and does not report the same rule is what moves this to verified, and
 * `advice-settle.ts` is where it does. Whether one will is a fact about somebody's schedule, and this
 * sentence does not reach for it.
 */
export const CLAIMED_WITHOUT_REQUIREMENTS =
  'The owner says the work is done. This action names no requirement, so no assessment run can agree or ' +
  'disagree with that. What settles it is an advisory that reads the same resource and no longer reports ' +
  'the finding below.';

/** Only the two ends are coloured. Six neutral badges and one green one is a board that reads. */
export const STATE_TONE: Readonly<Record<ActionState, Tone>> = {
  draft: 'neutral',
  planned: 'neutral',
  'in-progress': 'neutral',
  blocked: 'warning',
  'ready-for-validation': 'neutral',
  verified: 'success',
  cancelled: 'neutral',
};

export const STATE_ICON: Readonly<Record<ActionState, LucideIcon>> = {
  draft: PencilLine,
  planned: CalendarClock,
  'in-progress': Play,
  blocked: Octagon,
  'ready-for-validation': Hourglass,
  verified: ShieldCheck,
  cancelled: CircleSlash,
};

/**
 * The order somebody working through a plan would choose.
 *
 * Blocked first rather than in-progress, because a blocker is the only row on the board whose next
 * move belongs to somebody who is not the owner. Cancelled and verified last: they are history.
 */
export const STATE_RANK: Readonly<Record<ActionState, number>> = {
  blocked: 0,
  'ready-for-validation': 1,
  'in-progress': 2,
  planned: 3,
  draft: 4,
  verified: 5,
  cancelled: 6,
};

/**
 * What the estate says about the claim, which is not what the owner says about the work.
 *
 * `contradicted` is the one this vocabulary exists for: somebody said it was done, a run since then
 * still measures the requirement as unmet, and a board that showed that row as finished would be the
 * feature turning into a way to close items.
 */
export const AGREEMENT_LABEL: Readonly<Record<Agreement, string>> = {
  unclaimed: 'Not claimed yet',
  awaiting: 'Awaiting a run',
  agreed: 'Estate agrees',
  contradicted: 'Still failing',
  unmeasured: 'Not measured',
  unjudged: 'No requirement to judge',
};

export const AGREEMENT_DETAIL: Readonly<Record<Agreement, string>> = {
  unclaimed: 'Nobody has said this is done, so there is nothing for a run to agree or disagree with yet.',
  awaiting: 'The owner says this is done. No run has measured the estate since, so the claim stands until one does.',
  agreed: 'A run since the claim measured every requirement this names as met.',
  contradicted:
    'The owner says this is done, and the run since then still measures at least one of its requirements as unmet. ' +
    'Either the change did not take, or it did not cover everything the check looks at.',
  unmeasured:
    'The latest run could not read the requirements this names, so it can neither agree nor disagree. This is not the ' +
    'same as failing.',
  unjudged:
    'This was raised from advisor advice and names no requirement, so an assessment run has nothing here to agree or ' +
    'disagree with, and this install keeps no advisory that could. What it is for is in the advice it came from.',
};

/**
 * The same six readings, for an action a scan cannot speak to.
 *
 * Every sentence above names a run and a requirement, and an action raised from advisor advice has
 * neither: it is answered by a later advisory no longer reporting one rule on one resource. Rendering
 * the assessment's wording there would tell a reader a requirement was measured, which is a claim no
 * field under it carries — the rule this repository has paid for four times, in `AGENTS.md`.
 *
 * The narrower claim is deliberate in `agreed`. An advisory that did not report the rule is not an
 * advisory that says the resource is well configured; it is one run of one rule, and the sentence goes
 * no further than that.
 */
export const ADVISED_AGREEMENT_DETAIL: Readonly<Record<Agreement, string>> = {
  unclaimed: 'Nobody has said this is done, so there is nothing for an advisory to agree or disagree with yet.',
  awaiting:
    'The owner says this is done. No advisory has read the estate since, so the claim stands until one does.',
  agreed: 'An advisory since the claim read the resource and did not report the rule this was raised from.',
  contradicted:
    'The owner says this is done, and an advisory since then reports the same rule on the same resource. Either the ' +
    'change did not take, or the advisory’s lookback window still covers the days before it.',
  unmeasured:
    'The latest advisory could not speak to this: it did not report the resource, formed no analysis for that advisor, ' +
    'or this build no longer carries the rule. This is not the same as the finding having gone.',
  unjudged:
    'This was raised from advisor advice and names no requirement, so an assessment run has nothing here to agree or ' +
    'disagree with, and this install keeps no advisory that could. What it is for is in the advice it came from.',
};

/**
 * The one badge that names its judge, said the other way.
 *
 * A partial map rather than a second full one, because five of the six labels are true under either
 * judge — "Still failing" and "Not measured" describe the reading, not who took it — and six copied
 * strings would drift one at a time. `awaiting` is the exception: it is the only label that says what
 * a reader is waiting for, and for an action naming no requirement no run is coming.
 */
const ADVISED_AGREEMENT_LABEL: Readonly<Partial<Record<Agreement, string>>> = {
  awaiting: 'Awaiting an advisory',
};

/**
 * Which of the two vocabularies an action is read in.
 *
 * The requirements it names, and nothing else. An action carrying advice *and* a requirement is judged
 * by the assessment — `progress.ts` says why — so the sentence a reader gets has to be the assessment's
 * there too, or the badge and the paragraph under it would describe different judges.
 */
export function agreementDetail(action: {
  readonly agreement: Agreement;
  readonly controlIds: readonly string[];
}): string {
  return advised(action) ? ADVISED_AGREEMENT_DETAIL[action.agreement] : AGREEMENT_DETAIL[action.agreement];
}

/** The badge over that paragraph, in the same vocabulary, for the one label where they differ. */
export function agreementLabel(action: {
  readonly agreement: Agreement;
  readonly controlIds: readonly string[];
}): string {
  const said = advised(action) ? ADVISED_AGREEMENT_LABEL[action.agreement] : undefined;
  return said ?? AGREEMENT_LABEL[action.agreement];
}

function advised(action: { readonly controlIds: readonly string[] }): boolean {
  return action.controlIds.length === 0;
}

export const AGREEMENT_TONE: Readonly<Record<Agreement, Tone>> = {
  unclaimed: 'neutral',
  awaiting: 'neutral',
  agreed: 'success',
  contradicted: 'danger',
  unmeasured: 'warning',
  // Neutral rather than warning. Nothing here went wrong: no requirement was named, so none went
  // unread, and a coloured badge would send somebody looking for a failure that is not there.
  unjudged: 'neutral',
};

export const AGREEMENT_ICON: Readonly<Record<Agreement, LucideIcon>> = {
  unclaimed: CircleDashed,
  awaiting: Hourglass,
  agreed: CircleCheck,
  contradicted: CircleX,
  unmeasured: CircleHelp,
  unjudged: CircleMinus,
};

export const LATENESS_LABEL: Readonly<Record<Lateness, string>> = {
  undated: 'No date',
  'on-time': 'On time',
  due: 'Due soon',
  overdue: 'Overdue',
};

/** Only the two that call for something. `On time` as a coloured badge is furniture on every row. */
export const LATENESS_TONE: Readonly<Record<Lateness, Tone>> = {
  undated: 'neutral',
  'on-time': 'neutral',
  due: 'warning',
  overdue: 'danger',
};

export const PRIORITIES: readonly ActionPriority[] = ['now', 'next', 'later'];

export const PRIORITY_LABEL: Readonly<Record<ActionPriority, string>> = {
  now: 'Now',
  next: 'Next',
  later: 'Later',
};

export const EFFORTS: readonly ActionEffort[] = ['small', 'medium', 'large', 'programme'];

/**
 * What each size means, in terms of who does it and for how long.
 *
 * Not hours, and not points. An hour estimate invites a schedule this app cannot keep, and points are
 * a local currency — one team's 5 is another's 2 — so a report that added them up would be arithmetic
 * on a unit that does not exist.
 */
export const EFFORT_LABEL: Readonly<Record<ActionEffort, string>> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
  programme: 'Programme',
};

export const EFFORT_DETAIL: Readonly<Record<ActionEffort, string>> = {
  small: 'One person, one sitting. A setting flipped, a tag added.',
  medium: 'One person, several days. A change with a rollout, or one that needs an approval.',
  large: 'More than one team, or a change that has to be staged. Weeks.',
  programme: 'Needs a project of its own.',
};

/**
 * Why a move needs a sentence beside it, or undefined where it does not.
 *
 * The same two the server insists on, and the prompt is the point: a form that demanded prose for
 * every move would collect a column of "as discussed", and one that demanded none for these two
 * would collect blockers nobody can clear.
 */
export function reasonPrompt(to: ActionState): string | undefined {
  if (to === 'blocked') return 'What is it blocked on? A blocker nobody named is a blocker nobody can clear.';
  if (to === 'cancelled') return 'Why is this being cancelled? Cancelling silently loses the fact that somebody considered it.';
  return undefined;
}

/** The label on the button that makes a move, which is a verb rather than the state's name. */
export const MOVE_LABEL: Readonly<Record<ActionState, string>> = {
  draft: 'Back to draft',
  planned: 'Plan it',
  'in-progress': 'Start it',
  blocked: 'Blocked',
  'ready-for-validation': 'Done, check it',
  // Never rendered: no route offers this move, because nobody may make it. Present so the record is
  // total over the states rather than partial with a lookup that can miss.
  verified: 'Verified by a run',
  cancelled: 'Cancel it',
};

/** What the date means now, in the words the reading calls for. */
export function duePhrase(action: Pick<ImprovementAction, 'due' | 'lateness'>, now = new Date()): string {
  if (action.due == null) return 'No date set. An action cannot be planned without one.';

  const due = new Date(action.due);
  if (Number.isNaN(due.getTime())) return 'The date on this action could not be read.';

  const date = dueDateOf(action.due);
  const days = Math.round(Math.abs(due.getTime() - now.getTime()) / 86_400_000);
  if (action.lateness === 'overdue') {
    return days === 0 ? `Was due today (${date}).` : `Overdue by ${plural(days, 'day')}, since ${date}.`;
  }
  if (action.lateness === 'due') return `Due in ${plural(days, 'day')}, on ${date}.`;
  return `Due ${date}.`;
}

/**
 * What a plan's rollup says, as one sentence.
 *
 * Written as the two things a reader acts on rather than as a total: "9 of 14 done" is the number an
 * executive asks for and it is the number that hides the four contradicted rows, which is the whole
 * defect this feature was built to avoid reproducing.
 */
export function standingPhrase(progress: {
  readonly states: Readonly<Record<ActionState, number>>;
  readonly contradicted: readonly string[];
  readonly overdue: readonly string[];
  readonly blocked: readonly string[];
  readonly settled: boolean;
}): string {
  const total = Object.values(progress.states).reduce((sum, count) => sum + count, 0);
  if (total === 0) return 'Nothing raised against this plan yet.';

  const calls = [
    progress.contradicted.length > 0 ? `${plural(progress.contradicted.length, 'action')} still failing` : undefined,
    progress.overdue.length > 0 ? `${String(progress.overdue.length)} overdue` : undefined,
    progress.blocked.length > 0 ? `${String(progress.blocked.length)} blocked` : undefined,
  ].filter((part): part is string => part != null);

  if (calls.length > 0) return `${capitalised(calls.join(', '))}.`;
  // A plan of one reads "Every one of the 1 actions", which is where a labs plan with a single verified
  // action put it. `plural` covers the count, and the singular wants a different sentence rather than a
  // different noun — "every one of the one action" is no better.
  if (progress.settled) {
    return total === 1
      ? 'The one action raised is verified or cancelled.'
      : `Every one of the ${String(total)} actions is verified or cancelled.`;
  }
  return `${plural(total, 'action')}, none of them late, blocked or contradicted.`;
}

/** Who did something and when, for a history row. */
export function transitionPhrase(entry: {
  readonly by: 'person' | 'run' | 'advisor';
  readonly who: string;
  readonly at: string;
}): string {
  // A run's `who` is a scan id rather than a person, so it is named as one, and an advisory's id is
  // the same shape. A history row reading "by 4f2c-…" beside rows naming colleagues is the one place
  // somebody would read a machine as a person, and it is the row carrying the app's strongest claim.
  const actor = TRANSITION_AUTHOR[entry.by];
  return `${actor == null ? entry.who : `${actor} ${entry.who}`} on ${dateOf(entry.at)}`;
}

/** What to call the id, where the id names a run of something rather than a person. */
const TRANSITION_AUTHOR: Readonly<Partial<Record<'person' | 'run' | 'advisor', string>>> = {
  run: 'run',
  advisor: 'advisory',
};

/**
 * The nearest date worth offering, which is tomorrow.
 *
 * The server refuses a date that has already passed, and a picker whose range starts today invites
 * exactly that: an action due today is an action that is late the moment it is agreed.
 */
export function earliestDue(now = new Date()): string {
  return new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
}

/**
 * The moment a chosen day ends, in UTC, which is what a date on an action means.
 *
 * Sent instead of the day's start because the two differ by a day for most of the world: a reader
 * west of UTC picking tomorrow would send a midnight that has already passed in UTC, and the server
 * would refuse a date the form had just offered them.
 */
export function endOfDay(date: string): string {
  return `${date}T23:59:59.999Z`;
}

/** The day part of a stored date, which is what a date input takes. */
export function dayOf(iso: string | undefined): string {
  if (iso == null) return '';
  const when = new Date(iso);
  return Number.isNaN(when.getTime()) ? '' : when.toISOString().slice(0, 10);
}

function dateOf(iso: string): string {
  const when = new Date(iso);
  return Number.isNaN(when.getTime())
    ? 'an unrecorded date'
    : when.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * The calendar day a person chose for an action, rather than the local day of the stored instant.
 *
 * Due dates are stored at 23:59:59.999Z so the server can compare them as instants without making a
 * date west of UTC immediately late. Formatting that instant in the reader's time zone moves it to
 * the next day east of UTC, even though the action still means the day chosen in the form. UTC here
 * preserves that chosen day; event timestamps continue to use the reader's local date via `dateOf`.
 */
function dueDateOf(iso: string): string {
  const when = new Date(iso);
  return Number.isNaN(when.getTime())
    ? 'an unrecorded date'
    : when.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

function capitalised(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
