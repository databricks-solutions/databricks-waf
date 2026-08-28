// The words the serverless page uses, in one place.
//
// Two of these are load-bearing beyond wording. `verdictDetail` is the sentence that keeps
// `unknown` from being read as a fourth grade of readiness — it is the absence of a verdict,
// and a label alone will not carry that. And `costPhrase` writes the range, which is the one
// number on the page somebody might take to a budget conversation: it has to read as an
// estimate spanning two ends, never as a figure, and it has to collapse gracefully when the
// two ends coincide rather than printing "$80 to $80".
//
// Nothing here claims the analysis affects the score, because it does not, and the page says
// so in its header rather than in a footnote.

import { Ban, CircleHelp, Hammer, Rocket, type LucideIcon } from 'lucide-react';
import type { ServerlessJob, ServerlessRuleKind, ServerlessVerdict } from '../api/types';
import type { Tone } from '../components/ui/StatusBadge';

/** Worst first: a hard blocker is the row that changes somebody's plan. */
export const VERDICTS: readonly ServerlessVerdict[] = ['blocked', 'rework', 'unknown', 'ready'];

export const VERDICT_LABEL: Readonly<Record<ServerlessVerdict, string>> = {
  ready: 'Could move',
  rework: 'Needs rework',
  blocked: 'Cannot move',
  unknown: 'Could not tell',
};

/**
 * What each verdict means, said in full somewhere on the page.
 *
 * `ready` is deliberately hedged and `unknown` deliberately blunt. The analysis reads the
 * compute a job ran on and cannot read the code it ran, so "could move" is the strongest
 * honest form of a positive verdict — and an unreadable cluster is not a clean one.
 *
 * The tense is load-bearing in the same way. The statement reads each cluster's *current*
 * configuration and joins it to runs from the window, so what these sentences may say is
 * what the compute looks like now, never what a past run met. A cluster reconfigured after
 * its last run is described by the new shape, and the statement's header says why an as-of
 * join is a different question rather than a better version of this one.
 */
export const VERDICT_DETAIL: Readonly<Record<ServerlessVerdict, string>> = {
  ready:
    'Nothing in how the compute these jobs used is configured today stops them moving. That is not the same as a ' +
    'job that will move cleanly: custom containers, Scala, RDD calls and cluster-scoped libraries all block on ' +
    'serverless and none of them are visible from here.',
  rework:
    'These can move once something specific changes first. Each one names what, and the work ranges from an ' +
    'afternoon to a data-access project.',
  blocked:
    'Serverless jobs compute does not support these as they stand, for a reason named against each job. ' +
    'Moving one means changing that first.',
  unknown:
    'No verdict. The compute these jobs used could not be read — either the run recorded no compute, or the ' +
    'cluster it names has no configuration on record. Not an obstacle, and not a clean bill of health either.',
};

/** Only the verdicts that call for a decision are coloured. See StatusBadge on why. */
export const VERDICT_TONE: Readonly<Record<ServerlessVerdict, Tone>> = {
  blocked: 'danger',
  rework: 'warning',
  unknown: 'neutral',
  ready: 'success',
};

/**
 * The shape, because `unknown` carries no fill and was text on a plain badge.
 *
 * A job whose compute could not be read presented identically to one nobody had a verdict for, and
 * the two are the same thing said twice — which is why it is the one verdict a reader most needs to
 * tell apart from the three that are answers.
 */
export const VERDICT_ICON: Readonly<Record<ServerlessVerdict, LucideIcon>> = {
  blocked: Ban,
  rework: Hammer,
  unknown: CircleHelp,
  ready: Rocket,
};

/** The kinds, in the order a reader works through one job's reasons. */
export const KIND_RANK: Readonly<Record<ServerlessRuleKind, number>> = {
  blocker: 0,
  rework: 1,
  unknown: 2,
  note: 3,
};

export const KIND_LABEL: Readonly<Record<ServerlessRuleKind, string>> = {
  blocker: 'Blocker',
  rework: 'Rework',
  unknown: 'Unreadable',
  note: 'Worth knowing',
};

/**
 * A cost range, or nothing.
 *
 * Written as "between X and Y" rather than "X–Y" because a dash between two currency amounts
 * reads as a subtraction at a glance, and this figure is quoted in meetings. When the two ends
 * coincide — a job with no measured start-up time to remove — it collapses to "about X", which
 * is honest: the range spans the start-up saving and there was none to span.
 */
export function costPhrase(estimate: ServerlessJob['estimate']): string | undefined {
  if (estimate == null) return undefined;
  const low = money(estimate.low, estimate.currency);
  const high = money(estimate.high, estimate.currency);
  return low === high ? `about ${high}` : `between ${low} and ${high}`;
}

/**
 * What moving everything movable might save, or cost, as one sentence.
 *
 * Signed deliberately: the arithmetic can come out either way, and a page that only ever
 * phrased this as a saving would be a page that quietly hid the estate where serverless is
 * dearer. The comparison is against the same jobs' present spend, not the estate's.
 */
export function savingPhrase(
  cost: number | undefined,
  estimate: { readonly low: number; readonly high: number; readonly currency: string } | undefined
): string | undefined {
  if (cost == null || estimate == null || cost <= 0) return undefined;

  const best = cost - estimate.low;
  const worst = cost - estimate.high;
  // Both ends the same side of zero, so the direction is not in doubt.
  if (worst > 0) return `Between ${money(worst, estimate.currency)} and ${money(best, estimate.currency)} less`;
  if (best < 0) {
    return `Between ${money(-best, estimate.currency)} and ${money(-worst, estimate.currency)} more`;
  }
  // Straddling zero, which is the honest answer surprisingly often: no direction is claimed.
  return `Somewhere between ${money(-worst, estimate.currency)} more and ${money(best, estimate.currency)} less`;
}

/**
 * Money, in the currency the billing tables named.
 *
 * No decimals above a hundred: this is an estimate built on an assumption about DBU parity,
 * and printing $12,481.37 asserts a precision the method does not have.
 */
export function money(amount: number, currency: string): string {
  const fraction = Math.abs(amount) >= 100 ? 0 : 2;
  try {
    return amount.toLocaleString(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: fraction,
      maximumFractionDigits: fraction,
    });
  } catch {
    // A currency code the browser does not know. Better to print the number with the code
    // beside it than to throw inside a render over a three-letter string.
    return `${amount.toLocaleString(undefined, { minimumFractionDigits: fraction, maximumFractionDigits: fraction })} ${currency}`;
  }
}

/**
 * How much of this job's measured time was cluster start-up, which is what the range spans.
 *
 * Said as a share rather than as seconds, because the point is not that a job spent nine
 * minutes starting clusters — it is that a tenth of what it was billed for was waiting.
 */
export function startupPhrase(share: number | undefined): string | undefined {
  if (share == null || share <= 0) return undefined;
  const percent = Math.round(share * 100);
  if (percent < 1) return 'Under 1% of its billed time was cluster start-up, which serverless does not charge for.';
  return `${String(percent)}% of its billed time was cluster start-up, which serverless does not charge for.`;
}

/** Where the estate stands overall, for the page's opening line. */
export function shareSentence(analysis: {
  readonly jobsRan: number;
  readonly alreadyServerless: number;
  readonly onWarehouse: number;
  readonly lookbackDays: number;
}): string {
  const { alreadyServerless, jobsRan, lookbackDays, onWarehouse } = analysis;
  const window = `the last ${String(lookbackDays)} days`;
  if (jobsRan === 0) return `No job ran in ${window}, so there is nothing to assess.`;

  const assessed = jobsRan - alreadyServerless - onWarehouse;
  const warehouses =
    onWarehouse > 0 ? ` ${plural(onWarehouse, 'job')} ran only on SQL warehouses, whose compute is a separate question.` : '';

  if (assessed <= 0) {
    return `All ${plural(jobsRan, 'job')} that ran in ${window} were already on serverless or a warehouse. Nothing to move.${warehouses}`;
  }
  return (
    `${plural(jobsRan, 'job')} ran in ${window}. ${String(alreadyServerless)} already ran entirely on serverless, ` +
    `and ${plural(assessed, 'job')} still used classic compute.${warehouses}`
  );
}

/**
 * When the analysis was read, for one older than the run showing it.
 *
 * Unreachable on an advisory run, and kept rather than deleted. The analysis was carried between
 * scans until row 33d, because a rerun that measured other pillars never read the job history and
 * dropping it emptied the page — so a record written before that move can still carry the stamp, and
 * a page that ignored it would present a fortnight-old reading as this run's. The sentence no longer
 * claims a reason, since the only reason it had was the scan behaviour that no longer exists.
 */
export function carriedPhrase(carriedFrom: { readonly measuredAt: string } | undefined): string | undefined {
  if (carriedFrom == null) return undefined;
  const when = new Date(carriedFrom.measuredAt);
  if (Number.isNaN(when.getTime())) return 'This analysis came from an earlier run, on a date that could not be read.';
  return (
    `Read on ${when.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })} by an ` +
    'earlier run, and carried forward rather than read again.'
  );
}

/**
 * Which region's published rate the estimate used, written as a place rather than a SKU.
 *
 * Shown because the rate is the one figure on this page a reader can check against a
 * published price list, and cannot check without knowing which region it was read at. The
 * price list spells its regions `US_EAST_N_VIRGINIA`; a sentence does not.
 */
export function ratePhrase(region: string | undefined): string | undefined {
  if (region == null || region === '') return undefined;
  return `Priced at the published serverless jobs rate for ${region.toLowerCase().replace(/_/g, ' ')}.`;
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}
