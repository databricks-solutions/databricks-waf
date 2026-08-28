// Emptying an install, which is a different act from sweeping one.
//
// # Why this is not a retention period of one day
//
// It was reachable that way, almost, and the "almost" is the whole phase. A sweep removes rows past a
// cutoff, per class, so "empty this install" meant setting all three periods to their one-day minimum,
// waiting a day, and sweeping — and the two definition tables are exempt, so what was left was an
// install holding every assessment anybody had ever defined. An administrator who wanted a clean
// install was left dropping the Lakebase schema by hand, out of band, unrecorded.
//
// So a reset ignores periods, because a period is a statement about age and a reset is not about age.
// It empties every table, including the two the sweep exempts and including the chained one. And it
// honours legal holds, because a hold is a statement that something must not be removed, which is
// exactly the case a reset must not be able to override.
//
// # The chain
//
// `audit_events` is chained, so the act with the most reason to be recorded is the one that destroys
// the record it would be recorded in. ADR 0048's amendment sets out the three ways that can go and
// takes the third: the log is emptied and the reset's own event becomes the chain's new root, at
// sequence 1, naming genesis as its predecessor. A reader who finds a chain nine events long finds the
// reason for it in the chain's first entry, rather than finding a truncation nothing accounts for.
//
// That is why the event carries `emptied`. Every other act's scale is recomputable from what survives
// it; this one's is not, and the root of a chain saying only "an install was reset" would be a record
// that an act happened rather than a record of the act.
//
// # What a reset does not promise
//
// It empties what is there when it runs. A scan already in flight writes its row when it finishes, so
// an install reset at 14:02 with a run that lands at 14:03 holds one scan — and the trail says so, in
// that order, which is the same thing that would be true of a run started a second after the reset.
// Refusing while a run is in flight was the alternative and it buys very little: the window it closes
// is seconds wide, the coupling it needs is the whole scanner, and an administrator emptying an
// install can stop a run themselves.

import type { LegalHold } from './retention.js';
import { holdsOver, RETENTION_CLASSES } from './retention.js';

/** One table a reset empties, and what a reader loses when it does. */
export interface Emptied {
  readonly table: string;
  /** What this holds, in the words the retention page already uses for the same tables. */
  readonly holds: string;
  /**
   * Whether a sweep can ever remove this.
   *
   * The reset plane's job is to show what the plane above it cannot: the two definition tables the
   * sweep exempts and the three that hold the retention position itself. Marking them here rather
   * than keeping a second list means a table added to `RESET_TABLES` has to answer the question.
   */
  readonly swept: boolean;
  /**
   * Which assessment a row here belongs to.
   *
   * `42a`'s census found the product recording this four different ways — a `definition_id` column on
   * three tables, and `stamp.definition.id`, `request.definition.id` and `assessment.definitionId`
   * inside three different jsonb bodies — and filtering on one of them, for one table. The classes
   * below are what `42b` keys and `42c` filters, and they are declared here rather than in a document
   * because the test at the bottom of `reset.test.ts` already holds this list to what `ensureSchema`
   * creates. A table added to the schema has to appear here, and appearing here means answering this.
   *
   * `scoped` carries its own key. `by-parent` is scoped *through* the row that owns it, and names
   * that row's table rather than describing it — a checkpoint has no assessment of its own, it has a
   * run's. The parent is data and not prose because a test follows it: a chain of parents has to end
   * at a `scoped` table, so a table whose owner turns out to be installation-wide cannot quietly
   * inherit a scope that does not exist. That is how the definition versions and the audit floor read
   * as they do below. `installation-wide` is the whole install's and is not owed a key.
   *
   * **The question is what a row records, not whether a constraint currently forces two assessments
   * to share it.** Those come apart, and getting them the wrong way round was the first pass at this
   * list. A plan extract records something about the estate — the plan for a shape in a workspace —
   * and two assessments seeing it want the same row, so the sharing its key forces is correct and the
   * table is installation-wide. An accepted risk records a judgement somebody made under an
   * assessment, and two assessments accepting the same requirement are two judgements; there the
   * sharing its `unique (control_id, ordinal, revision)` forces is a defect, and classifying by that
   * constraint would write the defect down as the design.
   *
   * Three tables were in that position — `accepted_risks`, `applicability_decisions` and
   * `month_publications` — and each now unique on the assessment as well as the rest of the key.
   * A key nothing enforces uniqueness against is a filter, not a boundary.
   *
   * ADR 0080 is why the axis is the assessment definition and not the customer: one install serves one
   * customer, so a customer is the install and the boundary worth enforcing is the one inside it.
   */
  readonly context: TableContext;
}

/** Why a table is in its class, in a sentence a reviewer can disagree with. */
interface Reasoned {
  readonly because: string;
}

export type TableContext =
  | (Reasoned & { readonly kind: 'scoped' })
  | (Reasoned & { readonly kind: 'by-parent'; readonly parent: string })
  | (Reasoned & { readonly kind: 'installation-wide' });

/** Derived, not restated: a fourth class has to be added to the union and nowhere else. */
export type ContextClass = TableContext['kind'];

/**
 * Every table this app owns, in the order a reset empties them.
 *
 * The list is here rather than derived from `ensureSchema`, because a reset needs an order and a
 * sentence per table and neither belongs in a DDL function. `reset.test.ts` holds it to the schema:
 * it boots the fake through `ensureSchema`, scrapes the tables that get created, and fails when the
 * two sets differ. So adding a table without deciding what a reset does with it is a failing test
 * rather than data that quietly survives being emptied.
 *
 * # Why the two audit tables are last, in that order
 *
 * Last for the reason the sweep gives: the log is where a reset that throws partway through gets
 * recorded, so it has to be the last thing such a reset has touched. Removing scans and then failing
 * on notes leaves an install whose account of the failure is intact; doing it the other way round
 * leaves a half-emptied install with nothing saying what happened.
 *
 * `audit_events` before `audit_floor` is the less obvious half. A crash between the two leaves an empty
 * log with a floor still declaring where the last sweep cut: `head()` continues from that floor, the
 * next event chains from its digest, and verification reads clean while saying the log begins above a
 * trim. That sentence is stale — it was a reset, not a trim. The other order leaves the prefix gone
 * with nothing left to account for it, which verification reports as a gap the app itself caused and
 * can no longer explain. Between a stale explanation and an unexplainable break, take the stale one.
 */
export const RESET_TABLES: readonly Emptied[] = [
  {
    table: 'assessment_setup_drafts',
    holds: 'Assessments somebody started writing and did not submit',
    swept: true,
    // The one table that was already doing all of this before `42` opened, and the pattern the rest
    // copies: a `definition_id` column, and a read that filters on it.
    context: { kind: 'scoped', because: 'A draft is a draft of one assessment, and reads already filter on it' },
  },
  {
    table: 'imported_evidence',
    holds: 'Collections an administrator ran and somebody uploaded',
    swept: true,
    // The one `42a` left open, and the schema answers it. Keyed by the digest of the probe set, which
    // is a fact about the estate that was collected and not about who reads it. Scoping it would mean
    // the same collection could be imported once per assessment, and the replay defence that primary
    // key *is* would weaken from "this file was already used here" to "already used by this
    // assessment". An import is an input; the scan that consumes it is the record that carries scope.
    context: { kind: 'installation-wide', because: 'Keyed by the probe-set digest, which is the replay defence' },
  },
  {
    table: 'attestations',
    holds: 'Answers a person gave to a requirement no scan can reach',
    swept: true,
    // ADR 0080 is careful here and the key must not overstate it: an answer's scope is a property of
    // the answer, defaulting to the assessment it was given under, with installation-wide an explicit
    // and attributed choice. The column carries that default; it does not make the choice unavailable.
    context: { kind: 'scoped', because: 'An answer defaults to the assessment it was given under' },
  },
  {
    table: 'decisions',
    holds: 'What was accepted, planned, or claimed fixed, and by whom',
    swept: true,
    context: { kind: 'scoped', because: 'A decision is about a requirement of one assessment' },
  },
  {
    table: 'improvement_plans',
    holds: 'Plans somebody opened, and who owns them',
    swept: true,
    context: { kind: 'scoped', because: 'A plan is raised from the findings of one assessment' },
  },
  {
    table: 'improvement_actions',
    holds: 'Work raised against a plan, and every state it moved through',
    swept: true,
    context: {
      kind: 'by-parent',
      parent: 'improvement_plans',
      because: 'An action belongs to the assessment its plan does',
    },
  },
  {
    table: 'validation_attempts',
    holds: 'Every attempt to validate claimed work, including the ones that failed',
    swept: true,
    context: {
      kind: 'by-parent',
      parent: 'improvement_actions',
      because: 'An attempt belongs to the assessment its action does',
    },
  },
  {
    table: 'accepted_risks',
    holds: 'Requirements somebody accepted rather than met, and who owned them',
    swept: true,
    // An acceptance is unique per assessment, not per install: two definitions can accept the same
    // requirement at the same ordinal. The constraint that makes that true is the partial pair
    // `accepted_risks_at_position_scoped` and `_unscoped`, which between them hold one acceptance per
    // position whether or not the row names an assessment.
    context: { kind: 'scoped', because: 'An acceptance is a judgement made under one assessment' },
  },
  {
    table: 'applicability_decisions',
    holds: 'Requirements a customer took out of their own score, and who owned the decision',
    swept: true,
    // Unique per assessment, by the same partial pair: `applicability_decisions_at_position_scoped`
    // and `_unscoped`.
    context: { kind: 'scoped', because: 'Taking a requirement out of a score names which score' },
  },
  {
    table: 'notes',
    holds: 'Observations somebody wrote, and who wrote them',
    swept: true,
    context: { kind: 'scoped', because: 'A note is written against a requirement of one assessment' },
  },
  {
    table: 'serving_declarations',
    holds: 'Which relations a customer says they serve, and what those must carry',
    swept: true,
    context: {
      kind: 'scoped',
      because:
        'A declaration is a statement about one assessment’s estate, and two assessments declaring the same relations are two statements',
    },
  },
  {
    // Before the review it belongs to, for the reason the pillar rows below it are.
    table: 'review_answers',
    holds: 'Answers given from inside a review, joining each attestation to the review that produced it',
    swept: true,
    context: {
      kind: 'by-parent',
      parent: 'assessment_reviews',
      because: 'An answer record belongs to the assessment its review does',
    },
  },
  {
    // Before the review it belongs to, so a reset that fails between the two leaves records of a
    // review that is still there rather than pillar rows belonging to nothing.
    table: 'pillar_reviews',
    holds: 'Each pillar of a review, confirmed or skipped, and who recorded it',
    swept: true,
    context: {
      kind: 'by-parent',
      parent: 'assessment_reviews',
      because: 'A pillar record belongs to the assessment its review does',
    },
  },
  {
    // Before all three parents it cites. The review and definition-version edges are old; the scan
    // edge arrived with Version 2 results and is the one a populated Labs reset exposed in `148`.
    table: 'assessment_results',
    holds: 'Finalised assessments, citing the run and the attestation ids they rest on',
    swept: true,
    context: { kind: 'scoped', because: 'A finalised result is of one assessment, and current is per assessment' },
  },
  {
    table: 'scans',
    holds: 'Completed runs, with every finding and every reading behind them',
    swept: true,
    context: {
      kind: 'scoped',
      because: 'A run is of one assessment, and the stamp inside the body has said so since A3',
    },
  },
  {
    table: 'assessment_reviews',
    holds: 'Reviews of completed runs, opened so a person can confirm or skip each pillar',
    swept: true,
    context: { kind: 'scoped', because: 'A review is of a run of one assessment' },
  },
  {
    table: 'month_publications',
    holds: 'Months published as an immutable record of what the operating cadence reported',
    swept: true,
    // Unique per assessment, by `month_publications_at_position_scoped` and `_unscoped`, so two
    // assessments can both publish a January.
    context: { kind: 'scoped', because: 'A published month reports one assessment, not the install' },
  },
  {
    // Before `runs`, so a failure between the two leaves checkpoints belonging to a run that is still
    // there rather than readings belonging to nothing. Only reachable in the one transaction's
    // rollback window, but the ordering costs nothing and the other way round is unexplainable.
    table: 'run_checkpoints',
    holds: 'Readings a run in flight had reached, kept so a retry does not read them again',
    swept: true,
    context: { kind: 'by-parent', parent: 'runs', because: 'A reading belongs to the assessment its run does' },
  },
  {
    table: 'run_attempts',
    holds: 'Each attempt at a run, including the ones that were killed',
    swept: true,
    context: { kind: 'by-parent', parent: 'runs', because: 'An attempt belongs to the assessment its run does' },
  },
  // Before the advisories for the reason those are before the runs: a retained plan names the advisory
  // that fetched it.
  {
    table: 'plan_extracts',
    holds: 'The query plans the advisor read, three executions per shape',
    swept: true,
    // `advisory_id` sits on the row and makes this look like an advisory's child, which is what it was
    // classified as first. The primary key says otherwise: `(workspace_id, shape, statement_id)`, so a
    // row is the latest plan seen for a shape in a workspace and the next advisory to see that shape
    // overwrites it, whatever assessment that advisory was of. `advisory_id` records which one last
    // observed it, not which one owns it. Keying this would claim a row belongs to one assessment
    // while the constraint has two of them sharing it.
    context: {
      kind: 'installation-wide',
      because: 'Keyed by workspace and shape, and shared by whichever advisory sees it next',
    },
  },
  // Before `runs` for the reason the checkpoints are: a run points at the advisory it produced, and the
  // other order leaves an advisory belonging to nothing.
  {
    table: 'advisories',
    holds: 'What the workload advisor concluded on each of its runs',
    swept: true,
    // Has carried the column since H6. Reads filter on it, so two assessments cannot share advice.
    context: { kind: 'scoped', because: 'An advisory is of one assessment, and has the column already' },
  },
  {
    table: 'runs',
    holds: 'Every run that was asked for, of either kind, and how it ended',
    swept: true,
    context: { kind: 'scoped', because: 'A run is of one assessment, of either kind' },
  },
  // The five a sweep never reaches, which is the reason a reset is its own act rather than a period of
  // one day. The first two are exempt on purpose — a run stamped with a version that is gone cannot
  // say what it was of — and the last three are the retention position itself.
  {
    // Before its definition, which owns the key this row references. This child edge was added after
    // reset's original order and would otherwise become the next refusal after results and scans.
    table: 'assessment_definition_versions',
    holds: 'Every version of every assessment, which is what a finished run cites to say what it was of',
    swept: false,
    // `by-parent` would be the easy answer and it is wrong: that class means scoped *through* a
    // parent, and this one's parent is the definitions table, which is not scoped either.
    context: { kind: 'installation-wide', because: 'A version of the thing the others are scoped to' },
  },
  {
    table: 'assessment_definitions',
    holds: 'Every assessment ever defined here, including archived ones',
    swept: false,
    // Not scoped by the thing it is. A definition keyed by a definition is a row pointing at itself,
    // and the list of assessments is the one list that has to show all of them.
    context: { kind: 'installation-wide', because: 'This is the thing the others are scoped to' },
  },
  {
    table: 'retention_periods',
    holds: 'How long each class is kept, and who set it. Emptied, so the periods return to their defaults',
    swept: false,
    // Retention is set by whoever administers the install, over classes of record rather than over
    // assessments, and a period that differed per assessment would make "how long is a scan kept"
    // unanswerable without knowing which scan.
    context: { kind: 'installation-wide', because: 'A period is set per class of record, by the install' },
  },
  {
    table: 'legal_holds',
    holds: 'Holds placed and lifted, including the record of what a released hold once preserved',
    swept: false,
    context: { kind: 'installation-wide', because: 'A hold stops a sweep, and a sweep is the install’s' },
  },
  {
    table: 'audit_events',
    holds: 'Every event this app recorded. The deletion itself becomes the first entry of the new log',
    swept: true,
    // The strongest installation-wide case on the list, and the one most tempting to get wrong. The
    // trail is hash-chained by `sequence`: one chain, verifiable end to end. Per-assessment chains
    // would be several partial trails none of which can show it is complete, and the acts worth
    // auditing most — defining an assessment, resetting the install — belong to no assessment at all.
    context: { kind: 'installation-wide', because: 'One hash chain, or several that cannot show they are whole' },
  },
  {
    table: 'audit_floor',
    holds: 'Where the trail begins, when a sweep has cut the start of it',
    swept: false,
    context: { kind: 'installation-wide', because: 'Where the one install-wide trail begins' },
  },
];

/** Counting and emptying, so the planning here can be tested without a database. */
export interface ResetTables {
  /** How many rows a table holds. No cutoff: a reset is not about age. */
  countRows(table: string): Promise<number>;
  /** Empties a table and answers how many rows it held. */
  empty(table: string): Promise<number>;
}

export interface ResetGateway extends ResetTables {
  /**
   * Runs the whole emptying as one transaction, with `legal_holds` locked against writers first.
   *
   * Both halves of that are load-bearing, and for different failures.
   *
   * **The transaction** is because sixteen tables emptied one statement at a time can stop in the
   * middle. A caller told "that failed" over an install that has lost its scans but kept its answers
   * is worse off than one told nothing: the report is wrong, and the state is one no page describes.
   * Throwing out of `run` therefore has to leave the install as it was.
   *
   * **The lock** is because `legal_holds` is one of the tables being emptied. Without it, a hold placed
   * while the loop is running is a hold this act then deletes — the one outcome the whole feature is
   * built to prevent, arriving through the feature itself. With it, the placement waits for the reset
   * to finish and then applies to an install that holds nothing, which is the honest ordering: the
   * hold arrived second.
   */
  resetting<T>(run: (within: ResetTables) => Promise<T>): Promise<T>;
}

export interface PlannedTable extends Emptied {
  readonly rows: number;
}

export interface ResetPlan {
  readonly at: Date;
  readonly tables: readonly PlannedTable[];
  /**
   * What a reset would destroy, not counting the trail.
   *
   * Two numbers rather than one, and the split is what makes the confirmation usable. `records` is
   * what an administrator is deciding about; `events` is the app's own bookkeeping, and it moves every
   * time anybody does anything — including every refused reset. Confirming against a total that
   * included the trail would mean a mistyped number refuses, the refusal records itself, and the
   * number the refusal reported is already wrong by one. The reader would be chasing it.
   */
  readonly records: number;
  readonly events: number;
  /** In-force holds, which refuse a reset outright. Empty when there are none. */
  readonly heldBy: readonly LegalHold[];
}

export interface Reset {
  readonly at: Date;
  readonly by: string;
  readonly emptied: readonly { readonly table: string; readonly removed: number }[];
  /** Everything, trail included, which is what the genesis event carries. */
  readonly rows: number;
  /** How many tables held anything. A reset of an empty install is honest about having removed nothing. */
  readonly tables: number;
}

/** Refused because something says this must not be removed. Thrown rather than returned — see below. */
export class InstallHeld extends Error {
  readonly kind = 'held';

  constructor(readonly holds: readonly LegalHold[]) {
    super(
      `A legal hold is in force (${holds.map((hold) => hold.id).join(', ')}), and a reset does not ` +
        'override one. Lift it first, which is itself recorded.'
    );
  }
}

/** Every in-force hold, whatever it covers. A reset crosses all three classes, so any hold refuses it. */
export function holdsRefusingReset(holds: readonly LegalHold[]): readonly LegalHold[] {
  const refusing = new Map<string, LegalHold>();
  for (const retentionClass of RETENTION_CLASSES) {
    for (const hold of holdsOver(retentionClass, holds)) refusing.set(hold.id, hold);
  }
  return [...refusing.values()];
}

/**
 * What a reset would destroy, without destroying it.
 *
 * Every table, including the empty ones. A plane that listed only the tables with rows in them would
 * shrink as the install emptied and would never quite say what the act covers, and "audit_floor: 0"
 * is the line that tells a reader the act reaches the thing that explains their trail.
 */
export async function planReset(
  gateway: ResetTables,
  holds: readonly LegalHold[],
  now: Date = new Date()
): Promise<ResetPlan> {
  const tables = await Promise.all(
    RESET_TABLES.map(async (one) => ({ ...one, rows: await gateway.countRows(one.table) }))
  );

  const events = tables.find((one) => one.table === 'audit_events')?.rows ?? 0;
  const records = tables.reduce((sum, one) => sum + one.rows, 0) - events;

  return { at: now, tables, records, events, heldBy: holdsRefusingReset(holds) };
}

/**
 * Empties every table, in the order `RESET_TABLES` declares, as one transaction.
 *
 * Sequentially rather than in parallel, which matters for one table in the list: the log is emptied
 * last so that a failure before it has somewhere to be recorded, and `Promise.all` would make the
 * ordering a coincidence of scheduling.
 *
 * The holds are read *inside* the transaction, after `resetting` has locked the table they live in,
 * and that ordering is the guarantee rather than a precaution. Read before the lock, the answer is a
 * fact about the past: a hold placed a millisecond later is in the same table this act is about to
 * empty, so the check would have passed, the hold would be deleted, and nothing anywhere would say a
 * hold had ever existed. Read after it, a concurrent placement is either already committed and refuses
 * this reset, or is waiting and finds an install that holds nothing. There is no third case.
 *
 * A reader rather than an array, for the same reason: an array is a value somebody sampled at a time
 * this function cannot see, and the whole point is *when* the read happens.
 *
 * It refuses on a hold even though the route ahead of it already has, which looks like belt and braces
 * because it is. The throw is for the second caller: A4's supervisor will one day run this from a job,
 * and a guarantee that lives only in one HTTP handler is a guarantee that lasts until somebody writes
 * the second entry point.
 */
export async function resetInstall(
  gateway: ResetGateway,
  holds: () => Promise<readonly LegalHold[]>,
  by: string,
  now: Date = new Date()
): Promise<Reset> {
  return gateway.resetting(async (within) => {
    const refusing = holdsRefusingReset(await holds());
    if (refusing.length > 0) throw new InstallHeld(refusing);

    const emptied: { table: string; removed: number }[] = [];
    for (const one of RESET_TABLES) {
      emptied.push({ table: one.table, removed: await within.empty(one.table) });
    }

    return {
      at: now,
      by,
      emptied,
      rows: emptied.reduce((sum, one) => sum + one.removed, 0),
      tables: emptied.filter((one) => one.removed > 0).length,
    };
  });
}
