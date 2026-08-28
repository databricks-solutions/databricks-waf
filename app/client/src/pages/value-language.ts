// The words for the four value figures and for a later reading of one action's advice.
//
// [ADR 0083](../../../../docs/decisions/0083-four-value-figures-none-of-which-is-a-score-and-only-a-measured-one-aggregates.md)
// says what the four figures are and that they are never added together. This file is where that
// survives contact with a sentence, and the sentences are the part most likely to break it: "we saved
// $40,000" is one addition away from every rule the server module refuses, and it is the sentence
// everybody wants written.
//
// So, four rules about what may be said here.
//
// **A movement is two readings, never their difference.** `movementPhrase` writes both and no delta —
// not because subtraction is hard, but because a subtraction asserts the two are comparable, and the
// only thing that knows whether they are is the server's `incomparable`. Where it says they are not,
// the reason is printed beside them instead.
//
// **A standing is what a run reported, never what it implies.** A rule that stopped firing means the
// later advisory did not report it, which is a fact about the advisory. Whether the work landed, or
// the job stopped running, or the analysis never reached it, is not in the payload — so `standingPhrase`
// says which of those the payload distinguishes and stops there.
//
// **Money is an estimate with an advisor's name on it.** Every total here is one advisor's arithmetic
// in one currency, and its label says whose. Two advisors' figures are two entries and never a sum.
//
// **The cleared count is a count.** It is the closest thing here to "this worked", and the reason it
// is not a money figure is in `value.ts`: an advisor computes its evidence inside the condition that
// fires, so the run that shows the work landed carries no reading of what it fired on.

import type { AdviceReading, AdviceStanding, ValueMeasured, ValueMoney } from '../api/types';
import { money } from './serverless-language';
import { amountPhrase } from './workload-language';

/** Which advisor, in the words the Optimisation surface uses. Same list as `AdviceNote`'s. */
export const ADVISOR_LABEL: Readonly<Record<ValueMoney['advisor'], string>> = {
  workload: 'query workload',
  sizing: 'warehouse sizing',
  jobs: 'job health',
  writes: 'write patterns',
  serverless: 'serverless readiness',
};

/**
 * What the latest advisory said about the finding an action came from.
 *
 * Each of these is a restatement of one field. None of them says the work is done: `cleared` is the
 * one a reader will want to read that way, and what the payload holds is that a later run read the
 * resource and did not report this rule.
 */
export const STANDING_LABEL: Readonly<Record<AdviceStanding, string>> = {
  'still-firing': 'Still reported',
  cleared: 'No longer reported',
  'resource-absent': 'Not in the latest run',
  'advisor-unread': 'That advisor did not run',
  'rule-withdrawn': 'Rule withdrawn',
  'not-later': 'No later run yet',
};

/**
 * The same six, as a sentence saying what was read rather than what follows from it.
 *
 * `readingPhrase` rather than `standingPhrase`, which `improve-language` already has for the plan's
 * own standing. Two functions with one name is how the plan's progress ends up narrated by the
 * advisor's.
 */
export function readingPhrase(reading: AdviceReading): string {
  const day = reading.measuredAt.slice(0, 10);
  switch (reading.standing) {
    case 'still-firing':
      return `The advisory of ${day} reports the same rule on the same resource.`;
    case 'cleared':
      return `The advisory of ${day} read this resource and did not report this rule.`;
    case 'resource-absent':
      return `The advisory of ${day} reports nothing about this resource, which is not the same as reporting it clear.`;
    case 'advisor-unread':
      return `The advisory of ${day} formed no analysis for this advisor, so nothing in it looked for this rule.`;
    case 'rule-withdrawn':
      return 'This build no longer carries the rule this was raised from, so nothing looks for it.';
    case 'not-later':
      return 'The latest advisory is not later than the one this was raised from.';
  }
}

/**
 * One measure as it was and as it is, with no arithmetic between them.
 *
 * "Idle hours: 120 then, 40 now" rather than "80 fewer idle hours". The second is a subtraction, and
 * a subtraction is a claim that the two were measured the same way — which is the claim `incomparable`
 * exists to withhold.
 */
export function movementPhrase(movement: { readonly label: string; readonly unit: ValueMeasured['unit']; readonly before: number; readonly after: number }): string {
  return `${movement.label}: ${amountPhrase(movement.before, movement.unit)} then, ${amountPhrase(movement.after, movement.unit)} now`;
}

/**
 * Why two readings of the same measure may not be subtracted.
 *
 * Both reasons are about the apparatus rather than the estate, which is why they are printed as a
 * caution beside the numbers rather than as an absence of them: the readings are real and the
 * comparison is not.
 */
export function incomparablePhrase(reason: NonNullable<AdviceReading['incomparable']>): string {
  return reason === 'window'
    ? 'The two runs looked back over different numbers of days, so the readings are not measurements of the same span.'
    : 'The two runs ran different versions of the rules, so the readings may not be of the same thing.';
}

/**
 * One advisor's money, over what it is money about.
 *
 * `resources` rather than `actions`, because the advisors price a resource and two actions on one job
 * are one saving. Where the two counts differ, both are said — the difference is the whole reason the
 * money is not the size of the board.
 */
export function moneyPhrase(total: ValueMoney): string {
  const low = money(total.low, total.currency);
  const high = money(total.high, total.currency);
  const range = low === high ? `About ${high}` : `Between ${low} and ${high}`;
  const over = `${plural(total.resources, 'resource')}`;
  const work =
    total.actions != null && total.actions !== total.resources
      ? `, carrying ${plural(total.actions, 'action')}`
      : '';
  return `${range} across ${over}${work}`;
}

/** Where the range came from, and in whose arithmetic. Never omitted: an unattributed range is a promise. */
export function moneySource(total: ValueMoney): string {
  const region = total.region != null ? ` priced in ${total.region}` : '';
  return `${ADVISOR_LABEL[total.advisor]}'s own estimate${region}, in ${total.currency}.`;
}

/** How many measurements a total is over, so neither reading is a figure over nothing. */
export function measuredOver(measured: ValueMeasured): string {
  return `${ADVISOR_LABEL[measured.advisor]}, over ${plural(measured.measurements, 'measurement')}`;
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}
