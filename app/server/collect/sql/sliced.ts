// Executing one statement as several, over groups of workspaces, and reassembling the answer.
//
// Four statements cannot fit an inline result at the estate this app declares it assesses:
// `serverless_job_readiness` measures 27.6 MiB against a 25 MiB cap, and past the cap the Statement
// Execution API returns an error rather than fewer rows — so a large customer gets no assessment
// instead of a smaller one. Every alternative considered returned less: a sample, a top-N, a
// `GROUP BY`. All four statements are ones the app counts populations from, so all three of those
// change the answer rather than the transport. This one does not: the same rows arrive, in more
// responses.
//
// Which axis is safe is not decided here — it is declared in each statement's `-- Slice:` header and
// checked against the SQL by `slices.ts`, because a slice on a column the aggregates consume
// double-counts. This module is the loop that spends that proof, and the things the loop owes that
// the rule did not:
//
//   The order. Concatenation keeps every row and loses the row order. See concat.ts.
//
//   The budget. Each slice is submitted as its own scheduled task, so slices spend the `sql` surface
//   budget as the statements they are. Several executions inside one task would make the largest
//   thing a scan does invisible to the limit that exists to protect the customer's warehouse. Which
//   is also why there is a ceiling on how many slices a statement becomes — see `MAX_SLICES`.
//
//   The shortfall. Slices that partly failed produce a number that looks estate-wide and is not, so
//   what was read and what was not travels out of here with the rows.

import type { TaskOutcome } from '../../scan/scheduler.js';
import { type Bucket, refine } from './buckets.js';
import { resort } from './concat.js';
import type { SortColumn } from './slices.js';
import type { ColumnTypes, Row } from './rows.js';

/**
 * The most executions one statement is allowed to become.
 *
 * A slice per workspace was the first design and does not survive its own scale target. The declared
 * estate is 500 workspaces, so four sliced statements would be 2,000 executions against a `sql`
 * budget of 250 — the scan would exhaust partway through the first sliced statement and report every
 * signal after it as unmeasured. A change made so a large customer gets an assessment instead of
 * nothing would have given a large customer two signals instead of nineteen. Sequentially, at a few
 * seconds each, it would also have passed the 45-minute wall clock several times over.
 *
 * Twelve because it has to be small enough to leave the budget room for the other fifteen statements
 * and for H1e's sub-division of a slice that is still too large — 4 × 12 + 15 is 63 of 250 — and
 * large enough that a twelfth of the widest statement is comfortable: 27.6 MiB becomes 2.3 MiB, 9%
 * of the cap. A test derives the first half of that from `defaultLimits`, so raising the fan-out or
 * lowering the budget fails rather than degrades.
 *
 * It bounds the fan-out and not the slice size, which is the part it cannot do: an estate whose jobs
 * sit in one workspace has one huge slice however the groups are drawn, and that is H1e's case.
 */
export const MAX_SLICES = 12;

/**
 * The workspaces to execute for, grouped so there are never more groups than `MAX_SLICES`.
 *
 * Contiguous chunks of near-equal size. Not one workspace per group, for the reason above; not
 * interleaved, because nothing here knows which workspaces are large and pretending to balance them
 * would be a guess dressed as a distribution. Under the ceiling this is one workspace per group,
 * which is what almost every real account gets.
 *
 * Every group is non-empty and their union is the input in order, which is what keeps the split
 * lossless: each group's filter is the statement's own `live_workspace_ids` predicate over a subset,
 * and the subsets partition the set.
 */
export function sliceGroups(workspaces: readonly string[], max: number = MAX_SLICES): string[][] {
  if (workspaces.length <= max) return workspaces.map((workspace) => [workspace]);

  const size = Math.ceil(workspaces.length / max);
  const groups: string[][] = [];
  for (let at = 0; at < workspaces.length; at += size) groups.push([...workspaces.slice(at, at + size)]);
  return groups;
}

/**
 * The most executions one statement is allowed to become in total, slices and sub-slices together.
 *
 * `MAX_SLICES` bounds the workspace fan-out; this bounds what sub-division adds to it. Sub-division is
 * driven by the estate rather than by the plan — a skewed account subdivides and an even one does not
 * — so without a ceiling here the widest statement on the worst estate would be twelve groups times
 * twenty sub-slices, and four such statements would be 960 executions against a budget of 250 and a
 * 45-minute wall clock.
 *
 * Thirty-six leaves 4 × 36 + 15 = 159 of 250 for the worst case the app can produce, and at the ~6.5s
 * a statement measured on a real warehouse that is about 17 minutes. A group refused by this ceiling is
 * reported as a shortfall, which is the same treatment a group whose slice failed gets, and it is why
 * the ceiling is safe to have: it costs coverage of part of the estate and says so, rather than costing
 * the scan.
 */
export const MAX_EXECUTIONS = 36;

/**
 * How many times a slice may be sub-divided.
 *
 * Two levels is `FAN_OUT²` — sixteen buckets — so a group is divided until it is a sixteenth of itself,
 * which at the 20 MiB truncation limit is 320 MiB of one workspace's jobs. An estate past that is past
 * what this design covers, and it says so through the shortfall rather than recursing until the budget
 * or the wall clock stops it somewhere unpredictable.
 */
export const MAX_DEPTH = 2;

/** What one slice returns: its rows, and the column types needed to re-sort them faithfully. */
export interface Slice {
  readonly rows: readonly Row[];
  /** From the result manifest. Absent for a fixture, and `concat.ts` falls back to the values. */
  readonly types?: ColumnTypes;
  /**
   * Whether the warehouse stopped short of the end of this slice.
   *
   * `rows` is then a prefix and not a partition of anything, so it is discarded rather than kept: every
   * row in a sliced reading comes from a slice that completed, which is what lets the numbers computed
   * over them be described as exact for the part of the estate covered.
   */
  readonly truncated?: boolean;
}

/** How much of a sliced statement was read, and why the rest was not. */
export interface Shortfall {
  readonly read: number;
  readonly of: number;
  readonly why: string;
}

/** A slice that did not answer: the scheduler's own outcome, minus the successful case. */
export type FailedSlice = Exclude<TaskOutcome<Slice>, { readonly status: 'ok' }>;

export type SlicedReading =
  /**
   * Rows, and the estate they are short of.
   *
   * A partial reading is `read` rather than a failure because it succeeded: the rows are real, and
   * every aggregate in them was computed over every row it would have been — the slice axis is a
   * partition of the grouping key, which is what `slices.ts` establishes. What it lacks is part of
   * the estate, which is a coverage statement. Reporting it as a failure would discard nine groups of
   * evidence to describe two; reporting it as a plain success is the overclaim that cost this app its
   * populations once already.
   */
  | { readonly status: 'read'; readonly rows: Row[]; readonly shortfall?: Shortfall }
  /** No slice answered, or the scan stopped. Either way there is no reading, only the reason. */
  | { readonly status: 'none'; readonly outcome: FailedSlice };

export interface SlicedOptions {
  /** The groups to execute for, in the order the executions should happen. */
  readonly groups: readonly (readonly string[])[];
  /** The statement's own `ORDER BY`, from `orderKey`. Undefined leaves slice order alone. */
  readonly order: readonly SortColumn[] | undefined;
  /**
   * Runs one slice as a scheduled task. The caller binds the workspaces, and the bucket when there is
   * one, into the statement.
   */
  readonly run: (workspaces: readonly string[], bucket?: Bucket) => Promise<TaskOutcome<Slice>>;
  /** Turns failed slices into the sentence a user reads. */
  readonly describe: (outcomes: readonly FailedSlice[]) => string;
  /**
   * The column a slice too large to return is bucketed on, or undefined when the statement declared no
   * axis finer than the workspace. Undefined means a truncated slice is a shortfall rather than a
   * sub-division; see `bucketColumn`.
   */
  readonly bucketOn?: string;
  /** Overridden in tests, which have neither a real budget nor the patience for thirty-six calls. */
  readonly limit?: number;
}

/**
 * A scan-level stop, as opposed to one slice failing.
 *
 * Cancellation and an exhausted budget are properties of the scan, so the slices after them will not
 * run either, and continuing the loop only spends round trips to be refused. They also mean
 * something different from a slice that failed: the unsliced path reports both as unmeasured, and a
 * sliced statement claiming `sampled` coverage of a cancelled scan would say "497 of 500 did not
 * complete… re-running picks up the rest. The scan was cancelled before this check ran", which
 * contradicts itself twice in one sentence.
 */
function stoppedTheScan(outcome: FailedSlice): boolean {
  return outcome.status === 'skipped' && (outcome.reason === 'cancelled' || outcome.reason === 'budget-exhausted');
}

/**
 * The statement's rows, gathered one group at a time.
 *
 * Sequential rather than parallel. The scheduler bounds concurrency anyway, and the reason it does
 * applies with more force here: this turns four statements into up to forty-eight, and issuing those
 * together would put the customer's own queries behind all of them.
 */
export async function collectSlices(options: SlicedOptions): Promise<SlicedReading> {
  const limit = options.limit ?? MAX_EXECUTIONS;
  const rows: Row[] = [];
  const failed: FailedSlice[] = [];
  /** Shortfalls with no scheduler outcome behind them: a truncation nothing could subdivide. */
  const refusals = new Set<string>();
  let types: ColumnTypes | undefined;
  let short = 0;
  let spent = 0;

  /**
   * One slice — or one bucket of one — and everything it had to be divided into to come back whole.
   *
   * `owed` is how many executions the groups after this one still need. Checked before subdividing so
   * that one pathological workspace cannot spend the statement's whole allowance and leave the rest of
   * the estate unread: a group that would consume the reserve is refused and reported, which costs its
   * own coverage rather than everyone else's.
   */
  /** Records why part of the estate is missing, and reports the slice as incomplete. */
  const refuse = (why: string): Gathered => {
    refusals.add(why);
    return { status: 'read', rows: [], incomplete: true };
  };

  const gather = async (
    workspaces: readonly string[],
    bucket: Bucket | undefined,
    depth: number,
    owed: number
  ): Promise<Gathered> => {
    if (spent + owed >= limit) return refuse(exhausted(limit));

    spent += 1;
    const outcome = await options.run(workspaces, bucket);

    if (outcome.status !== 'ok') {
      // A stop ends the statement rather than shortening it, and the rows already read are dropped
      // with it. Deliberate: the alternative reports a fraction of the estate as a measurement of it
      // on a scan the user cancelled, and every other signal in that scan says unmeasured.
      if (stoppedTheScan(outcome)) return { status: 'stop', outcome };
      failed.push(outcome);
      return { status: 'read', rows: [], incomplete: true };
    }

    if (outcome.value.truncated !== true) {
      return { status: 'read', rows: outcome.value.rows, ...(outcome.value.types && { types: outcome.value.types }) };
    }

    // Too large to return. The rows in hand are a prefix of this slice, so they are dropped and the
    // slice is asked for again in pieces — see `bucketed`. What cannot be asked for again in pieces is
    // reported: a statement with no finer axis has not been shown safe to bucket, and past `MAX_DEPTH`
    // or the execution ceiling there is no allowance left to do it with.
    if (options.bucketOn == null) return refuse(UNDIVIDABLE);
    if (depth >= MAX_DEPTH) return refuse(TOO_LARGE);

    const children = refine(bucket);
    if (spent + children.length + owed > limit) return refuse(exhausted(limit));

    const gathered: Row[] = [];
    let whole = true;
    for (const child of children) {
      const got = await gather(workspaces, child, depth + 1, owed);
      if (got.status === 'stop') return got;
      for (const row of got.rows) gathered.push(row);
      types ??= got.types;
      if (got.incomplete === true) whole = false;
    }

    // A group is read only if every bucket of it was. The rows of the buckets that answered are kept —
    // each is a complete row of a complete group, because the bucket column is a key of the statement's
    // own `GROUP BY` — but the group counts against coverage, because part of it is missing. Why it is
    // missing was recorded by whichever bucket could not be read, which is where the specifics are.
    return { status: 'read', rows: gathered, ...(whole ? {} : { incomplete: true }) };
  };

  for (const [at, group] of options.groups.entries()) {
    const got = await gather(group, undefined, 0, options.groups.length - at - 1);
    if (got.status === 'stop') return { status: 'none', outcome: got.outcome };

    // Appended one at a time rather than spread. `push(...rows)` passes one argument per element and
    // throws `RangeError: Maximum call stack size exceeded` somewhere above 100,000 of them — which
    // `compute_cluster_inventory` reaches inside a single slice on a real account, and which would
    // escape the collector and take every sql signal down with it rather than becoming one
    // unmeasured result.
    for (const row of got.rows) rows.push(row);
    types ??= got.types;
    if (got.incomplete === true) short += 1;
  }

  // Nothing answered and a scheduler outcome to say why, so this is the statement failing rather than
  // a short reading of it. Reported as the first failure so its reason — a missing grant, a throttle, a
  // timeout — reaches the user instead of an empty result that reads as an estate with nothing in it.
  //
  // Both conditions are load-bearing. Every group being short is not enough on its own, because a group
  // divided into buckets can be short and still have returned most of itself — three of four buckets is
  // three quarters of a workspace, and discarding it to report the fourth one's error would throw away
  // evidence to describe the lack of evidence. And no rows is not enough on its own either, because
  // every slice answering with no rows is a measurement: an estate with no jobs. Which of those two an
  // empty result means is decided by the statement's own `noAnswer`, and it cannot decide it if this
  // collapses them here.
  //
  // A statement that was only ever truncated has no outcome to report and falls through to the
  // shortfall below, where the collector turns an empty reading with a shortfall into the same
  // unmeasured result.
  const first = failed[0];
  if (first != null && short === options.groups.length && rows.length === 0) {
    return { status: 'none', outcome: first };
  }

  return {
    status: 'read',
    rows: resort(rows, options.order, types),
    ...(short === 0
      ? {}
      : {
          shortfall: {
            read: options.groups.length - short,
            of: options.groups.length,
            why: [options.describe(failed), ...refusals].filter((why) => why !== '').join(' '),
          },
        }),
  };
}

/**
 * One slice's contribution: the rows it produced, and whether anything is missing from them.
 *
 * Why something is missing is not here. A slice divided into buckets can be short for four different
 * reasons at two levels of recursion, and threading the prose back up would produce a sentence per
 * level about the same gap; the reasons are collected once, where they are discovered.
 */
type Gathered =
  | {
      readonly status: 'read';
      readonly rows: readonly Row[];
      readonly types?: ColumnTypes;
      readonly incomplete?: boolean;
    }
  | { readonly status: 'stop'; readonly outcome: FailedSlice };

const UNDIVIDABLE =
  'One workspace returned more than an inline result can carry, and this statement declares no ' +
  'axis inside a workspace to divide it on, so that workspace is not included.';

const TOO_LARGE =
  'One workspace returned more than an inline result can carry even divided sixteen ways, so it is ' +
  'not fully included. This is an estate larger than this scan is built for; ask Databricks.';

function exhausted(limit: number): string {
  return (
    `Dividing this statement far enough to return the largest workspaces would have taken more than ` +
    `the ${String(limit)} warehouse executions one check is allowed, so the largest are not included.`
  );
}

/**
 * What a partly-read statement is a statement about, in the words a reader gets verbatim.
 *
 * Kept next to the loop rather than in the collector's coverage function because the numbers and the
 * sentence have to agree, and they are assembled a few lines apart here.
 *
 * In slices rather than workspaces, because slices are what failed: under the `MAX_SLICES` ceiling
 * they are the same number, and above it a group is several workspaces and saying "workspaces" would
 * be a count of the wrong thing.
 */
export function describeShortfall(shortfall: Shortfall): string {
  const missing = shortfall.of - shortfall.read;
  return (
    `this statement is executed once per group of workspaces and ${String(missing)} of ` +
    `${String(shortfall.of)} groups did not complete, so the counts here cover the ${String(shortfall.read)} that ` +
    `did and are lower than the estate's. Re-running the scan picks up the rest. ${shortfall.why}`
  );
}
