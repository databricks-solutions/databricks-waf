// The words the warehouses page uses, in one place.
//
// The formatting helpers are the workloads page's — `duration`, `bytes`, `evidencePhrase`, the severity
// and confidence labels — imported rather than repeated, because the two pages sit in the same group and a
// reader moving between them should not find bytes rendered at two different scales.
//
// What is here is what this page says and the other one cannot:
//
//   `STATE_DETAIL` carries the four answers "no findings" can mean. A warehouse that coped, one nobody
//   asked anything of, and one whose whole workload is this app are three different sentences, and a page
//   that showed an empty finding list for all three would be inviting the reader to guess which.
//
//   `utilisationSentence` says what the utilisation figure is *not*. It is statement execution per
//   cluster-millisecond of paid uptime, which reads like a CPU figure and is not one, and a reader who
//   took it for one would draw the wrong conclusion about a warehouse sitting at 6%.
//
//   `configurationLine` is the row's second line. It names the size, the cluster range and the auto-stop
//   because those are the three things a reader would change, and a page that made them click through to
//   find out what the current setting is has made the advice harder to act on than to ignore.

import { CircleDashed, Cpu, Gauge, MoonStar, Power, Zap, type LucideIcon } from 'lucide-react';
import type { Sizing, WarehouseSizing, WarehouseState } from '../api/types';
import type { Tone } from '../components/ui/StatusBadge';
import { duration } from './workload-language';

/** Advised first: the page is ordered by whether there is anything to do. */
export const WAREHOUSE_STATES: readonly WarehouseState[] = [
  'advised',
  'clean',
  'unmeasured',
  'unused',
  'assessment-only',
];

export const STATE_LABEL: Readonly<Record<WarehouseState, string>> = {
  advised: 'Something to change',
  clean: 'Coped with its work',
  unmeasured: 'Nothing timed',
  unused: 'Not used',
  // Not "measuring ourselves", which is what this said and which is the tool talking about itself in a
  // list of the customer's warehouses. The reader's question is what ran on it, and the answer is nothing
  // of theirs.
  'assessment-only': 'Only this assessment ran',
};

/** Only "something to change" is coloured. The rest are states, not grades. */
export const STATE_TONE: Readonly<Record<WarehouseState, Tone>> = {
  advised: 'warning',
  clean: 'success',
  unmeasured: 'neutral',
  unused: 'neutral',
  'assessment-only': 'neutral',
};

export const STATE_ICON: Readonly<Record<WarehouseState, LucideIcon>> = {
  advised: Gauge,
  clean: Zap,
  unmeasured: CircleDashed,
  unused: MoonStar,
  'assessment-only': Cpu,
};

/**
 * What each state means, said in full.
 *
 * `assessment-only` exists so that `unused` stays true. Every figure on this page excludes the
 * assessment's own statements, which means a warehouse whose only traffic was the assessment has no
 * statements left to count — and reporting the warehouse that runs the assessment as unused invites the
 * reader to delete it.
 *
 * `unmeasured` is the one the first labs run caught being told as `clean`. A warehouse whose statements
 * were all cached, cancelled or failed has no timings, so every rule declined for want of a measurement —
 * and "coped with its work" was a claim about evidence that did not exist.
 */
export const STATE_DETAIL: Readonly<Record<WarehouseState, string>> = {
  advised:
    'At least one rule fired on how this warehouse ran. Each finding below carries the numbers behind it and ' +
    'what to change; the order is what went wrong first and what could be cheaper last.',
  clean:
    'This warehouse was asked for real work and handled it: nothing queued for capacity, nothing spilled to ' +
    'disk, and its slowest statements were not slow enough to suggest a different size. Nothing to change.',
  unmeasured:
    'Statements ran on this warehouse and none of them were timed — every one was served from the result cache, ' +
    'cancelled, or failed. So there is no duration, no queueing and no spill to read, and no rule fired for want ' +
    'of a measurement rather than because the size is right.',
  unused:
    'No statement ran on this warehouse in the window, so there is no workload to size it against. Whether it ' +
    'should exist at all is an assessment question rather than an advisory one — the auto-stop control covers it.',
  'assessment-only':
    'The only statements on this warehouse in the window were this assessment reading system tables, and those ' +
    'are excluded from every figure on this page. So there is no workload of yours to size it against — which is ' +
    'not the same as an idle warehouse, because this is the one the assessment runs on. A dedicated 2X-Small is ' +
    'the tidiest home for it: the assessment stays off the warehouses your work uses, and this row stays this ' +
    'row rather than becoming a share of somebody else\u2019s.',
};

/**
 * The four facts a badge needs about a state, and the reason this is a function rather than four lookups.
 *
 * An advisory is stored, and a stored one outlives the build that wrote it. Renaming a state to
 * `assessment-only` was enough to crash the deployed app on labs: the analysis on disk still said `ours`,
 * `STATE_ICON['ours']` was `undefined`, and React was handed `undefined` where a component goes — so the
 * whole page became an error boundary rather than a warehouse list with one odd row in it.
 *
 * So every read of these records goes through here, and an unrecognised state gets a badge instead of a
 * crash. Which is the honest rendering of it in any case: the app cannot say what a word means that it
 * does not know, and the reader's next move is the same either way — run the advisor and read a current
 * answer rather than a translation of an old one.
 *
 * Deliberately not a migration. Mapping `ours` onto `assessment-only` would be tidier and would be a lie:
 * that warehouse ran 4,345 statements of which most, not all, were the assessment's, and "only this
 * assessment ran" is a claim the old record does not support.
 */
export interface StateFacts {
  readonly label: string;
  readonly tone: Tone;
  readonly Icon: LucideIcon;
  readonly detail: string;
}

export function stateFacts(state: WarehouseState): StateFacts {
  const label = STATE_LABEL[state] as string | undefined;
  if (label != null) {
    return { label, tone: STATE_TONE[state], Icon: STATE_ICON[state], detail: STATE_DETAIL[state] };
  }
  return {
    label: 'State not recognised',
    tone: 'neutral',
    Icon: CircleDashed,
    detail:
      'This analysis records a state this build of the app does not have a name for, which means it was ' +
      'produced by a different version. The warehouse and its figures are shown as they were recorded; the ' +
      'verdict is not, because translating one would mean guessing what it meant. Run the advisor again for ' +
      'a reading this build can describe.',
  };
}

export const NOT_SCORED = 'Not scored';

/**
 * The warehouse's current configuration, as the row's second line.
 *
 * Every part is omitted rather than defaulted when the inventory could not be matched. A row reading
 * "Small · 1 cluster" about a warehouse whose definition was never read would be inventing the
 * configuration it is advising on.
 *
 * The fallback names both reasons rather than the first one. It said "the warehouse no longer exists",
 * which is one cause and was the wrong one on labs: the event stream is read across the metastore and the
 * inventory only covers the workspaces the run had reach into, so two perfectly live warehouses in
 * unreached workspaces were reported as deleted.
 */
export function configurationLine(warehouse: WarehouseSizing): string {
  const parts: string[] = [];
  if (warehouse.size != null) parts.push(warehouse.size);
  if (warehouse.serverless != null) parts.push(warehouse.serverless ? 'Serverless' : 'Classic');
  if (warehouse.minClusters != null && warehouse.maxClusters != null) {
    parts.push(
      warehouse.minClusters === warehouse.maxClusters
        ? `${String(warehouse.maxClusters)} cluster${warehouse.maxClusters === 1 ? '' : 's'}`
        : `${String(warehouse.minClusters)}–${String(warehouse.maxClusters)} clusters`
    );
  }
  if (warehouse.autoStopMinutes != null) {
    parts.push(warehouse.autoStopMinutes === 0 ? 'never stops' : `stops after ${String(warehouse.autoStopMinutes)} min`);
  }
  return parts.length === 0
    ? 'No definition read — it has been deleted, or it is in a workspace this run could not reach'
    : parts.join(' · ');
}

/** What it was asked to do, as the row's summary. Runs and time, or the fact that it ran nothing. */
export function workloadLine(warehouse: WarehouseSizing): string {
  if (warehouse.runs === 0) {
    return warehouse.upMs > 0
      ? `Up for ${duration(warehouse.upMs)} and ran nothing`
      : 'No statements and no uptime recorded';
  }
  const runs = `${warehouse.runs.toLocaleString()} statement${warehouse.runs === 1 ? '' : 's'}`;
  const days = `${String(warehouse.daysUsed)} day${warehouse.daysUsed === 1 ? '' : 's'}`;
  return `${runs} over ${days} · ${duration(warehouse.totalMs)} elapsed`;
}

/**
 * What the utilisation figure means, spelled out.
 *
 * The number is statement execution divided by cluster-milliseconds of uptime. It looks like a CPU
 * utilisation and is not one — nothing in the two system tables behind this measures how busy a cluster's
 * cores were — and it can legitimately exceed 100 on a concurrent warehouse, because statements execute at
 * once and their durations sum past the wall clock. Both facts change what a reader should do about a low
 * number, so both are said rather than left to a tooltip.
 *
 * The share is printed, and the denominator it is over is named. Saying "of 50 h up, 2.8 h went on
 * executing" and stopping there let a reader work out 5.6% from the two numbers on the page while the rules
 * were firing on 5.7% — because the divisor is cluster time, not the wall clock, and that warehouse reached
 * two clusters. A number a reader can check has to be the number the engine used.
 */
export function utilisationSentence(warehouse: WarehouseSizing): string | undefined {
  if (warehouse.executionPercent == null || warehouse.upMs === 0) return undefined;
  const share = `${String(warehouse.executionPercent)}%`;
  const paid = duration(warehouse.clusterMs);
  const busy = duration(warehouse.busyMs);
  const clock = paidDiffers(warehouse)
    ? ` It was up for ${duration(warehouse.upMs)} by the wall clock; the figure divides by paid cluster time, which is more where more than one cluster ran.`
    : '';

  if (warehouse.executionPercent > 100) {
    return (
      `Statements executed for ${busy} against ${paid} of paid cluster time — ${share}, over a hundred because ` +
      `several ran at once and their durations sum past the wall clock. That is concurrency doing what it is ` +
      `for rather than an error.${clock}`
    );
  }
  return (
    `Statements executed for ${busy} of the ${paid} of cluster time the account paid for — ${share}. That is ` +
    `execution produced per paid millisecond, not how busy the cores were; nothing here measures that.${clock}`
  );
}

/**
 * That the window opened with this warehouse already up, where it did.
 *
 * `carriedIn` is the one field that separates a warehouse observed running throughout the window from
 * one whose uptime is inferred from a single event before it, and until it was rendered nothing on the
 * page could tell them apart — a warehouse that has been up for a month and was never resized records no
 * event inside a seven-day window at all, so `Times it started` reads 0 beside six days of uptime.
 *
 * What it does not say is how much of the uptime that accounts for. The field is one bit: the seed
 * interval exists. So the sentence names the session and not a duration, and the reason is here rather
 * than only in the statement, because a sentence that named a share would need a column that carries one.
 */
export function carriedSentence(warehouse: WarehouseSizing): string | undefined {
  if (!warehouse.carriedIn) return undefined;
  return (
    'It was already running when the window opened, so its uptime is counted from the window’s first instant ' +
    'rather than from anything recorded in it. A warehouse up throughout records no event, which is why it can ' +
    'show uptime and no starts.'
  );
}

/**
 * Whether paid cluster time is worth naming separately from the wall clock.
 *
 * Compares what the reader will see rather than what the record holds, and that is the whole point of the
 * function. Labs had a warehouse 34 seconds apart on 46.4 hours: the raw milliseconds differed, so the page
 * printed a second row reading `Paid cluster time 46.4 h` directly beneath `Time up 46.4 h` and a sentence
 * promising a difference between two identical strings. A distinction the display rounds away is not a
 * distinction on the page.
 */
export function paidDiffers(warehouse: WarehouseSizing): boolean {
  return duration(warehouse.clusterMs) !== duration(warehouse.upMs);
}

/**
 * Where the event stream and the current definition disagree about how many clusters this warehouse runs.
 *
 * Both are sincere and the page shows them a panel apart: labs had a warehouse configured for exactly one
 * cluster with a peak of two in the event stream, because the definition is the one that exists now and the
 * events are what happened over the week. A reader left to reconcile those two numbers concludes the page is
 * wrong, so where they disagree the page says which is which.
 */
export function clustersSentence(warehouse: WarehouseSizing): string | undefined {
  const max = warehouse.maxClusters;
  if (max == null || warehouse.peakClusters <= max) return undefined;
  return (
    `It ran ${String(warehouse.peakClusters)} clusters at its peak against a configured maximum of ${String(max)}. ` +
    'The configuration above is the one in place now; the peak is what the week recorded.'
  );
}

/**
 * Where the estate's warehouses stand, for the page's opening line.
 *
 * Names three numbers a reader would otherwise have to reconcile themselves: how many warehouses ran
 * anything, how many exist, and how many the window saw at all. The third is the one that matters on a
 * large estate — the statement returns the busiest two hundred, and a page that showed two hundred rows
 * without saying so would be describing a fraction of the fleet as though it were the fleet.
 *
 * "Ran statements" means the estate's own, since the assessment's are excluded before anything here counts
 * them. So a warehouse whose only traffic was the assessment is not among them, and where that is the whole
 * story the sentence says so rather than reporting an estate that ran nothing.
 */
export function sizingSentence(analysis: Sizing): string {
  const window = `${String(analysis.windowDays)} days`;
  if (analysis.used === 0) {
    // Labs is the case this exists for: the only warehouse in the workspace is the one the app runs on, so
    // "no warehouse ran a statement" sits above a row headed "only this assessment ran" and reads as a
    // contradiction. Naming the exclusion costs a clause and settles it.
    const oursOnly = analysis.warehouses.some((one) => one.state === 'assessment-only');
    return oursOnly
      ? `No warehouse ran a statement of yours in the last ${window} — the assessment's own are excluded — so ` +
          'there is nothing to size against.'
      : `No warehouse ran a statement in the last ${window}, so there is nothing to size against.`;
  }
  const used = `${String(analysis.used)} warehouse${analysis.used === 1 ? '' : 's'} ran statements in the last ${window}`;
  const outOf = analysis.live == null ? '' : ` of ${String(analysis.live)} in the estate`;
  return `${used}${outOf}. ${verdict(analysis)}`;
}

/**
 * What the run concluded, with "nothing found" and "nothing assessed" kept apart.
 *
 * One way left, and it earns its clause: a warehouse whose statements were never timed needs nothing done
 * about it — it is a fact about the workload rather than a gap in the advice. There used to be a second,
 * for warehouses whose work was mostly the assessment's own, and it went when those statements stopped
 * being counted at all.
 */
function verdict(analysis: Sizing): string {
  const untimed = analysis.warehouses.filter((one) => one.state === 'unmeasured').length;

  const clauses = [
    analysis.findingCount === 0
      ? undefined
      : `${String(analysis.findingCount)} finding${analysis.findingCount === 1 ? '' : 's'} across them`,
    untimed === 0 ? undefined : `${String(untimed)} ran nothing that could be timed`,
  ].filter((clause): clause is string => clause != null);

  if (clauses.length === 0) return 'No rule fired on any of them.';
  const assessed = analysis.used - untimed;
  // Only where there are warehouses the clauses do not account for. "Nothing fired on the rest" with no
  // rest is a sentence about an empty set, which reads as a second finding-free verdict.
  const rest = analysis.findingCount === 0 && assessed > 0 ? ' Nothing fired on the rest.' : '';
  return `${capitalise(list(clauses))}.${rest}`;
}

function list(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1] ?? ''}`;
}

function capitalise(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/**
 * Whether the list is the whole population, and what it is a subset of when it is not.
 *
 * Two different subsets, and both have to be said because the numbers in the line above expose both. The
 * cap is the collector's `warehouseLimit` and only bites on a large estate. The second is ordinary and was
 * confusing on the first run: the estate had 21 warehouses and the page listed 5, because a warehouse that
 * never started, never stopped and ran nothing appears in neither system table the window reads. A reader
 * left to reconcile "21 in the estate" against five rows would reasonably conclude the page was broken.
 *
 * The quiet count is `live` minus `matched`, not minus the population. Labs listed five warehouses of
 * which three were in an inventory of twenty-one — the other two were in workspaces the run had no reach
 * into — so subtracting the population claimed sixteen quiet warehouses where eighteen were.
 *
 * Absent where the page is the whole story, because a disclosure about a limit that did not apply is noise.
 */
export function capSentence(analysis: Sizing): string | undefined {
  const shown = analysis.warehouses.length;
  const capped =
    shown < analysis.population
      ? `Showing the ${String(shown)} busiest of ${String(analysis.population)} warehouses the window saw — the rest ran less than any of these.`
      : undefined;
  const quiet = analysis.live == null ? 0 : analysis.live - analysis.matched;
  const rest =
    quiet > 0
      ? `${String(quiet)} of the estate's ${String(analysis.live ?? 0)} warehouses neither ran a statement nor started or stopped in the window, so there is nothing recorded to size them against.`
      : undefined;
  return [capped, rest].filter((part): part is string => part != null).join(' ') || undefined;
}

/**
 * Which rules produced this, and why this page's window is not the run's.
 *
 * One advisory run reports three windows — the run's own lookback, fifteen days of query history on the
 * workloads page and seven here — and each is defensible on its own while nothing on any page explains the
 * difference. A reader comparing two pages in the same group concludes one of them is stale, so the reason
 * is stated where the window is.
 */
export function rulesSentence(analysis: Sizing): string {
  return (
    `Assessed against sizing rule set ${String(analysis.rulesVersion)} over ${String(analysis.windowDays)} days ` +
    'of history — shorter than the rest of the run, because every rule here counts the days something happened ' +
    'on and a day count is only readable against one denominator.'
  );
}

/** The single worst thing found, for the row that has one line to say it in. */
export function leadSizingFinding(warehouse: WarehouseSizing): string | undefined {
  return warehouse.findings[0]?.headline;
}

export const SIZING_ICON = Power;
