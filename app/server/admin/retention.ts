// How long this app keeps what it wrote, and what stops it removing something.
//
// The gap this closes is not that data was kept too long. It is that there was no way to *state* a
// position: evidence, identities and resource names sat in the schema indefinitely, and the first
// question an enterprise privacy review asks is what the retention period is. "Forever, and there is
// no setting" is an answer that ends a procurement conversation.
//
// # Three classes, not eight tables
//
// A period per table would be eight settings an administrator has to reason about individually, and
// the reasoning is the same for several of them. So the periods are declared over three classes,
// which are the three different *reasons* something is kept (AUD-DEC-104):
//
//   temporary   — working state with no evidential value. An unfinished assessment nobody submitted.
//   assessment  — what was measured, and the evidence behind it. A scan; a collected upload.
//   governance  — what somebody asserted, decided, or did. An answer; a decision; an audit event.
//   advisory    — advice, kept to see whether it was taken. A workload advisor run and its findings.
//
// The defaults are the approved ones: 30 days, 24 months, 7 years. They are defaults rather than
// constants because the decision was that this is administrator-configurable, and a customer whose
// legal position is five years should not have to fork the app to say so.
//
// The fourth class arrived with the advisor (ADR 0061, built as ADR 0069) and is a fourth *reason*
// rather than a fourth table, which is the test this list applies. Advice is kept to find out whether
// anybody acted on it, which is neither what was measured nor what somebody asserted. It is also the
// only class here where a longer period makes the product worse: a two-year-old assessment is an old
// assessment and still true of the estate it describes, where two-year-old advice shown as current
// describes a workload nobody would recognise. 90 days is three months, so a monthly cadence has
// something to compare against, and short of where the advice stops being about anything.
//
// # Nothing is removed on a timer
//
// A sweep happens when an administrator asks for one. That is not a shortcut around a scheduler: the
// worker that would run it unattended is A4 and does not exist, and a retention policy enforced by a
// setInterval in a web process is a policy that stops being enforced the next time the platform
// scales the app to zero — silently, which is the worst way for a deletion guarantee to fail.
//
// So what this builds is the position and the authorized act: the policy is stated, what it makes
// eligible is reported, and removal happens when somebody with permission asks and is recorded as
// something they did. When A4 lands, the sweep it runs is this one.
//
// # What is deliberately not removed
//
// Assessment definitions, and the reason is the one the plan already states about them: a run stamped
// with a definition version that is no longer stored is a finished assessment that cannot say what it
// was of. Removing a definition to satisfy a retention period would silently damage every surviving
// run that cites it, which is a worse outcome than keeping a record of what a customer chose to
// assess. The personal data in a definition is its owners, and the answer to that is anonymisation
// rather than deletion — see the plan's second half.
//
// The same reasoning does not apply to the rest: an answer or a decision is read on its own terms, and
// a removed scan takes its own findings with it — with one exception since C2. A published month cites
// the runs behind it, and it outlives them: a publication is `governance` at 2555 days against a scan's
// 730, so a swept scan can leave a published August pointing at a run that is gone. Denormalisation is
// most of the answer — the month keeps its own copy of everything it reported, so what is lost is a
// drill-through and not the record — and a link into a removed run is shown as removed rather than
// 404ing. See ADR 0072.

import type { AuditTarget } from '../audit/event.js';

/** Why something is kept, which is what a period is set against. */
export type RetentionClass = 'temporary' | 'assessment' | 'governance' | 'advisory';

export const RETENTION_CLASSES: readonly RetentionClass[] = ['temporary', 'assessment', 'governance', 'advisory'];

/**
 * The approved defaults, in days (AUD-DEC-104).
 *
 * Days rather than months or years for every class, because a period a customer configures has to be
 * comparable with the one beside it and "24 months or 730 days" is two units for one setting. 730 and
 * 2555 are the plain readings of 24 months and 7 years, and neither is trying to be a calendar.
 */
export const DEFAULT_PERIOD_DAYS: Readonly<Record<RetentionClass, number>> = {
  temporary: 30,
  assessment: 730,
  governance: 2555,
  advisory: 90,
};

/** The shortest and longest a period may be set to. */
export const MIN_PERIOD_DAYS = 1;
export const MAX_PERIOD_DAYS = 36_500;

export interface RetentionPolicy {
  readonly periods: Readonly<Record<RetentionClass, number>>;
  /** Who last set it, and when. Absent while the defaults have never been changed. */
  readonly setBy?: string;
  readonly setAt?: Date;
}

export const DEFAULT_POLICY: RetentionPolicy = { periods: DEFAULT_PERIOD_DAYS };

/**
 * A reason not to delete something, placed by a person and outliving the policy.
 *
 * It covers classes rather than individual records, which is a deliberate coarseness: a hold exists
 * because of litigation or an investigation, and the thing being preserved at that point is not a row
 * somebody can enumerate in advance. A hold on `assessment` keeps every scan and every upload, which
 * is what "preserve the evidence" means when nobody yet knows which evidence matters.
 */
export interface LegalHold {
  readonly id: string;
  /** Why, in the words of whoever placed it. Required: a hold nobody can account for is never lifted. */
  readonly reason: string;
  readonly covers: readonly RetentionClass[];
  readonly placedBy: string;
  readonly placedAt: Date;
  /** Set when lifted. A released hold is kept rather than deleted, because it is part of the record. */
  readonly releasedBy?: string;
  readonly releasedAt?: Date;
}

/**
 * The one table that cannot be counted or removed by age alone.
 *
 * Named once and used by both the planning and the sweep, so the two cannot drift into disagreeing
 * about which table is the chained one. Everything else here is a set of rows; this is a sequence,
 * and both halves have to treat it as one.
 */
export const CHAINED_TABLE = 'audit_events';

/** Which class each table belongs to, and the column that gives a row its age. */
export interface Retained {
  readonly table: string;
  readonly retentionClass: RetentionClass;
  /** The column an age is measured from. The domain time, never `written_at`. */
  readonly stamp: string;
  /** What this holds, for a reader deciding whether a period is right. */
  readonly holds: string;
  /**
   * Which rows of the table this entry covers, when it does not cover all of them.
   *
   * One table, two classes, which `runs` needs and nothing else does: it holds assessment runs and
   * advisory runs (ADR 0069), and they are kept for different periods and held by different holds.
   * Without this the advisory ones would be swept on the assessment period — 730 days of advice about
   * workloads that stopped existing — and a litigation hold on assessments would preserve them.
   *
   * SQL, composed into a `where` clause, and safe for the same reason the table names here are: it
   * comes from this list and never from a request. It is not a general filter and should not become
   * one — a period is a statement about a kind of record, so a predicate that is not "which kind of
   * record is this" belongs somewhere else.
   *
   * **A function of the schema, because two of these name a second table and a bare name does not
   * resolve.** This app puts its tables in a schema of their own — `waf`, or whatever `WAF_PG_SCHEMA`
   * says — and sets no `search_path`, so `select id from runs` inside a clause is looked for in
   * `"$user"` and `public` and found in neither. It was a string for four months and the two
   * subquery clauses raised `relation "runs" does not exist` on every install for all of them: the
   * retention page counts every table in a class together, `run_attempts` is in two classes, and one
   * failing count rejects the whole page. `86` is the row, and the type is what stops it recurring —
   * a clause that needs the schema now has to be handed it.
   */
  readonly only?: Only;
}

/**
 * A row predicate, given the schema this app's tables are in.
 *
 * Named rather than written inline at the four places it appears, so the reason it is a function has
 * one home. The parameter is unused by the two clauses that name no second table, and that is the
 * point: it costs them nothing, and the two that do need it cannot be written without it.
 */
export type Only = (schema: string) => string;

/**
 * The tables a sweep touches, in the order it touches them.
 *
 * The audit log is last, and that ordering is load-bearing for one reason: it is the table that
 * records what the sweep did, and a sweep that throws partway through must not already have cut it.
 * Removing scans and then failing on decisions is a partial sweep whose account of itself is intact;
 * doing it the other way round is a partial sweep that has edited the only place the failure will be
 * written down. The act's own event is appended when the route closes the act, which is after the
 * trim, so the record of a sweep is above the floor that sweep declared rather than inside the
 * prefix it removed.
 *
 * `written_at` is never the stamp. It says when this app wrote the row, which for an imported
 * collection is months after the evidence was collected, and a retention period is a statement about
 * the age of the *information* rather than about when it arrived here.
 */
export const RETAINED: readonly Retained[] = [
  {
    table: 'assessment_setup_drafts',
    retentionClass: 'temporary',
    stamp: 'saved_at',
    holds: 'Assessments somebody started writing and did not submit',
  },
  {
    table: 'scans',
    retentionClass: 'assessment',
    stamp: 'started_at',
    holds: 'Completed runs, with every finding and every reading behind them',
  },
  {
    table: 'imported_evidence',
    retentionClass: 'assessment',
    stamp: 'generated_at',
    holds: 'Collections an administrator ran and somebody uploaded',
  },
  {
    table: 'attestations',
    retentionClass: 'governance',
    stamp: 'attested_at',
    holds: 'Answers a person gave to a requirement no scan can reach',
  },
  {
    table: 'decisions',
    retentionClass: 'governance',
    stamp: 'decided_at',
    holds: 'What was accepted, planned, or claimed fixed, and by whom',
  },
  {
    table: 'improvement_plans',
    retentionClass: 'governance',
    stamp: 'created_at',
    holds: 'Plans somebody opened, what they were meant to achieve, and who owns them',
  },
  {
    // Aged from the plan's date rather than its own, so a plan and the work inside it go together.
    // An action raised eleven months into a long plan would otherwise outlive the plan by eleven
    // months, and what survives is a commitment with nothing recording what it was part of.
    table: 'improvement_actions',
    retentionClass: 'governance',
    stamp: 'plan_created_at',
    holds: 'Work raised against a plan, its owner, its definition of done, and every state it moved through',
  },
  {
    // Aged from the plan's date, like the actions above and for the reason one layer further on: an
    // attempt is the evidence behind a `verified`, so an attempt that outlived its action would be a
    // record of a validation of work nothing describes, and one swept before its action would leave the
    // verification citing evidence nobody can read.
    table: 'validation_attempts',
    retentionClass: 'governance',
    stamp: 'plan_created_at',
    holds: 'Every attempt to validate claimed work, what the estate said, and the ones that failed',
  },
  {
    // Aged from when the acceptance was recorded rather than from when it expired, which are up to a
    // year apart. The date the governance period runs from is the date somebody made the decision:
    // measured from the expiry, an acceptance renewed four times would keep its whole chain alive for a
    // year past the last renewal, and the first link — the one saying how long this has really been
    // carried — is the one worth keeping longest.
    table: 'accepted_risks',
    retentionClass: 'governance',
    stamp: 'recorded_at',
    holds: 'Requirements somebody accepted rather than met, what was holding the line, and who owned it',
  },
  {
    // Governance, and aged from when the decision was recorded rather than its expiry, for the reason
    // the accepted risks are: the date somebody made the decision is the one a governance period runs
    // from, and the first link of a renewed chain is the one worth keeping longest.
    table: 'applicability_decisions',
    retentionClass: 'governance',
    stamp: 'recorded_at',
    holds: 'Requirements a customer took out of their own score, why, and who owned the decision',
  },
  {
    // Governance rather than assessment, even though most notes are written about one run.
    //
    // A note is somebody's words with their name on it, which is the property that decides the class
    // everywhere else in this table: an attestation and a decision are kept for the governance period
    // for the same reason. Filed as assessment, a note explaining why a pillar looks the way it does
    // would be swept with the runs it was about, and what it explained would be the part that survived.
    table: 'notes',
    retentionClass: 'governance',
    stamp: 'noted_at',
    holds: 'Observations somebody wrote about a run, a pillar or a requirement, and who wrote them',
  },
  {
    table: 'pillar_reviews',
    retentionClass: 'governance',
    stamp: 'recorded_at',
    holds: 'Each pillar of a review, confirmed or skipped, and who recorded it',
  },
  {
    // Governance, with the review it belongs to. The attestation it names is governance too, and a
    // shorter period here would leave the answer standing with nothing recording that a review
    // produced it — which is the only thing this row is for.
    table: 'review_answers',
    retentionClass: 'governance',
    stamp: 'recorded_at',
    holds: 'Answers given from inside a review, joining each attestation to the review that produced it',
  },
  {
    table: 'assessment_results',
    retentionClass: 'governance',
    stamp: 'finalised_at',
    holds: 'Finalised assessments, citing the run and the attestation ids they rest on',
  },
  {
    // Governance rather than assessment, for the same reason a note is: a review is somebody's
    // judgement with their name on it. Filed as assessment, a review of a run would be swept with
    // the run, and the result that cited it would be the part that survived.
    table: 'assessment_reviews',
    retentionClass: 'governance',
    stamp: 'opened_at',
    holds: 'Reviews of completed runs, opened so a person can confirm or skip each pillar',
  },
  {
    // Governance, and the longest-lived record here for the reason a cadence exists: August has to be
    // answerable in December, and by more than five years when an administrator lengthens the period.
    // Aged from when it was published rather than the month it covers, because the record is the act of
    // publishing and that is the date somebody would account for. A publication outlives the runs it
    // cites, which is why the sweep comment above no longer claims a removed scan leaves nothing
    // dangling — the month keeps its own denormalised copy, so what a swept run costs is a
    // drill-through. See ADR 0072.
    table: 'month_publications',
    retentionClass: 'governance',
    stamp: 'published_at',
    holds: 'Months published as an immutable record of what the operating cadence reported',
  },
  // The four entries below are two tables split by run kind, and they are in this order on purpose.
  //
  // Both attempt entries come before both run entries, because an attempt's kind is a property of the
  // run it belongs to and is read by looking the run up. Sweep the runs first and that lookup finds
  // nothing, so the attempts of every swept run become rows no period can ever reach again. It is a
  // leak that would never be noticed, because the table it fills is one nobody reads directly.
  {
    table: 'run_attempts',
    retentionClass: 'advisory',
    stamp: 'started_at',
    holds: 'Each attempt at an advisory run, including the ones that were killed and taken over',
    only: (schema) => `run_id in (select id from ${schema}.runs where kind = 'advisory')`,
  },
  {
    // Aged from its own start rather than from the run's date, unlike the actions above, and the
    // difference is a matter of scale rather than of principle: an attempt begins within seconds of
    // the run being asked for, so the two dates are minutes apart and carrying the run's date onto the
    // row would be a column that never changes the answer.
    table: 'run_attempts',
    retentionClass: 'assessment',
    stamp: 'started_at',
    holds: 'Each attempt at an assessment run, including the ones that were killed and taken over',
    // `is null` as well, because a row written before the kind column existed is an assessment — the
    // advisor is what added it. The same reasoning as `reviveRun`, and it has to be repeated here
    // rather than shared, because this is SQL and that is TypeScript. If the default in one ever
    // changes, this is the other place.
    only: (schema) => `run_id in (select id from ${schema}.runs where kind = 'assessment' or kind is null)`,
  },
  {
    // Before the advisories, for the reason those are before the runs: a plan names the advisory that
    // fetched it, and sweeping the advisory first would leave a plan pointing at nothing.
    //
    // Swept as well as counted. `plan-store.ts` keeps three executions per shape, which bounds a shape
    // that is still running and never reaches one that stopped — a shape with no new executions never
    // displaces its own third row, so without a period its plans would be kept forever.
    //
    // Aged from the advisory that filed it rather than from the execution it describes, which is the
    // same denormalised parent stamp `improvement_actions` carries and for a sharper version of the
    // reason. The row also holds `observed_at`, when the query ran, and that is up to a lookback window
    // before the run: aging from it would make a period shorter than the lookback sweep plans on the day
    // they were written, leaving a shape holding one execution or none where the count says three. The
    // trim never notices — it only removes a fourth — so the comparison this table exists for would
    // quietly stop being possible while `retainedPlans` went on reporting the writes.
    table: 'plan_extracts',
    retentionClass: 'advisory',
    stamp: 'advisory_at',
    holds: 'The query plans the advisor read, three executions per shape, for comparing one against the next',
  },
  {
    // The one class where a longer period makes the product worse rather than better. Stale advice
    // presented as current is a wrong answer, where an old assessment is only an old assessment — so
    // this is 90 days by default rather than filed under the assessment period. See ADR 0069.
    //
    // Before the `runs` entries in this list, so an advisory is never left pointing at a run that has
    // been swept. Ordering in `RETAINED` is what the sweep follows.
    table: 'advisories',
    retentionClass: 'advisory',
    stamp: 'finished_at',
    holds: 'What the workload advisor concluded, kept long enough to see whether anybody acted on it',
  },
  {
    // 90 days rather than the 730 the runs beside it get, which is the point of splitting the table:
    // advice is kept to see whether it was taken, and advice nobody acted on two years ago is not a
    // finding about an estate that still exists.
    table: 'runs',
    retentionClass: 'advisory',
    stamp: 'requested_at',
    holds: 'Every advisory run that was asked for, what was asked, and how it ended',
    only: () => "kind = 'advisory'",
  },
  {
    // Filed with the scans it produces, and swept on the same period, so a run and the assessment it
    // ran are never separated: a scan whose run record had been swept could not say how many attempts
    // it took, and a run whose scan was gone would point at nothing.
    table: 'runs',
    retentionClass: 'assessment',
    stamp: 'requested_at',
    holds: 'Every assessment run that was asked for, what was asked, and how it ended',
    only: () => "kind = 'assessment' or kind is null",
  },
  {
    // Temporary, and the only table here whose rows are meant to be gone long before a sweep reaches
    // them: a checkpoint is deleted when its run reaches a terminal state, because what it holds is
    // then a second copy of readings the scan already has. What a sweep catches is the residue — runs
    // triggered once, killed, and never retried, whose checkpoints nothing will ever read. A month is
    // far past the point where a supervisor would have retried, so anything still here is abandoned.
    table: 'run_checkpoints',
    retentionClass: 'temporary',
    stamp: 'at',
    holds: 'Readings a run had reached, kept only so a retry does not read them again',
  },
  {
    table: 'audit_events',
    retentionClass: 'governance',
    stamp: 'at',
    holds: 'Every event this app recorded, including refused and failed actions',
  },
];

/** What the sweep does not touch, and why. Served rather than only commented, so the page can say it. */
export const EXEMPT: readonly { readonly table: string; readonly because: string }[] = [
  {
    table: 'assessment_definition_versions',
    because:
      'A run is stamped with the definition version it answers to. Removing the version would leave a ' +
      'finished assessment unable to say what it was of, which is worse than keeping it. The personal ' +
      'data in a definition is its owners, and anonymisation is the answer to that rather than deletion.',
  },
  {
    table: 'assessment_definitions',
    because: 'Held for as long as its versions are, for the same reason.',
  },
  {
    table: 'serving_declarations',
    because:
      'The newest row is configuration rather than a record: it is what this organisation currently ' +
      'says it serves, and a period would delete it on an install that had not revised it in a year. ' +
      'The older rows are the revisions, and they are what lets a reader see that the population ' +
      'behind a share changed rather than the estate. The personal data in one is who declared it, ' +
      'and anonymisation is the answer to that rather than deletion.',
  },
];

/** How many rows a table holds, and how many of them are older than a cutoff. */
export interface Eligibility {
  readonly table: string;
  readonly total: number;
  readonly eligible: number;
  /** The age of the oldest row, so a period can be judged against what is actually there. */
  readonly oldest?: Date;
}

/**
 * What reading and removing needs from the database, so the planning above can be tested without one.
 *
 * `only` arrives as a function rather than a clause, and the implementation is what supplies the
 * schema. That is deliberate and is `86`: the planning here has no schema to give — it is the half of
 * retention that knows nothing about a database — so a clause naming a second table can only be
 * qualified by the gateway. Passing a finished string let two of them ship naming a bare `runs`,
 * which resolves nowhere and failed the retention page outright.
 */
export interface RetentionGateway {
  count(table: string, stamp: string, before?: Date, only?: Only): Promise<Eligibility>;
  /** Removes rows older than the cutoff and answers how many. */
  remove(table: string, stamp: string, before: Date, only?: Only): Promise<number>;
  /**
   * How much of the audit log a trim would take, counted the way the trim counts.
   *
   * Its own method rather than `count` against `at`, because the two do not agree and the
   * disagreement is not academic. A trim stops at the first event that must be kept and takes the
   * contiguous prefix below it, so an event stamped before the cutoff but sequenced above one that
   * must be kept is *not* eligible however old it is — the alternative is a gap. Counting by age
   * would show it as due for removal, and then a sweep confirmed against that number would remove
   * fewer rows than the person confirming it was shown. A confirmation is only worth asking for if
   * the number it confirms is the number that happens.
   */
  countAuditPrefix(before: Date): Promise<Eligibility>;
  /**
   * Removes a contiguous prefix of the audit log and declares where it now starts.
   *
   * Its own method because the audit log cannot be deleted from the way the other tables can: a gap
   * in the middle of a chain is indistinguishable from an event somebody removed to hide it, so a
   * trim takes a prefix and records the digest it now begins after. See `audit-log.ts`.
   */
  trimAuditPrefix(before: Date, by: string): Promise<{ readonly removed: number; readonly floor?: number }>;
}

export interface PlannedClass {
  readonly retentionClass: RetentionClass;
  readonly periodDays: number;
  /** Rows stamped before this are eligible, unless a hold covers the class. */
  readonly cutoff: Date;
  /** The holds stopping this class from being swept. Empty when nothing is held. */
  readonly heldBy: readonly LegalHold[];
  readonly tables: readonly (Eligibility & { readonly holds: string })[];
}

export interface RetentionPlan {
  readonly at: Date;
  readonly policy: RetentionPolicy;
  readonly classes: readonly PlannedClass[];
  readonly holds: readonly LegalHold[];
  readonly exempt: readonly { readonly table: string; readonly because: string }[];
  /** How many rows a sweep would remove now. Zero when everything is inside its period or held. */
  readonly wouldRemove: number;
}

/** The holds in force over a class. A released hold is history and stops nothing. */
export function holdsOver(retentionClass: RetentionClass, holds: readonly LegalHold[]): readonly LegalHold[] {
  return holds.filter((hold) => hold.releasedAt == null && hold.covers.includes(retentionClass));
}

export function cutoffFor(periodDays: number, now: Date): Date {
  return new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);
}

/**
 * What the policy makes eligible, without removing anything.
 *
 * Always the whole picture rather than only the eligible rows: a page that showed "4 scans eligible"
 * and nothing else cannot answer the question an administrator actually has, which is whether the
 * period is right. The total and the age of the oldest row are what makes that judgeable.
 *
 * A held class still reports what it would remove. Reporting zero would make a hold look like a
 * period nothing has aged past, and the two are different facts about the same install — one lifts
 * when somebody lifts it, and the other lifts on its own.
 */
export async function planRetention(
  gateway: RetentionGateway,
  policy: RetentionPolicy,
  holds: readonly LegalHold[],
  now: Date = new Date()
): Promise<RetentionPlan> {
  const classes: PlannedClass[] = [];
  let wouldRemove = 0;

  for (const retentionClass of RETENTION_CLASSES) {
    const periodDays = policy.periods[retentionClass];
    const cutoff = cutoffFor(periodDays, now);
    const heldBy = holdsOver(retentionClass, holds);

    const tables = await Promise.all(
      RETAINED.filter((one) => one.retentionClass === retentionClass).map(async (one) => ({
        // The chained table is counted the way it is cut, not the way it is stamped. See
        // `countAuditPrefix`: counting it by age would report rows a sweep will not touch.
        ...(one.table === CHAINED_TABLE
          ? await gateway.countAuditPrefix(cutoff)
          : await gateway.count(one.table, one.stamp, cutoff, one.only)),
        holds: one.holds,
      }))
    );

    if (heldBy.length === 0) {
      wouldRemove += tables.reduce((sum, table) => sum + table.eligible, 0);
    }
    classes.push({ retentionClass, periodDays, cutoff, heldBy, tables });
  }

  return { at: now, policy, classes, holds, exempt: EXEMPT, wouldRemove };
}

export interface Removal {
  readonly table: string;
  readonly retentionClass: RetentionClass;
  readonly removed: number;
  readonly before: Date;
}

export interface Sweep {
  readonly at: Date;
  readonly by: string;
  readonly removals: readonly Removal[];
  readonly removed: number;
  /** Classes a hold kept whole, so the result says what it did not do as well as what it did. */
  readonly held: readonly { readonly retentionClass: RetentionClass; readonly holds: readonly string[] }[];
  /**
   * Where the audit log now begins, when the sweep trimmed it.
   *
   * Carried out of the sweep because it is the one number a verifier needs afterwards: the chain no
   * longer starts at genesis, and a reader who does not know that reads the first surviving event as
   * a link break.
   */
  readonly auditFloor?: number;
}

/**
 * Removes what the policy makes eligible, and answers what it removed.
 *
 * The audit log last, for the reason on `RETAINED`: it is where a failure partway through will be
 * recorded, so it is the last thing a failure partway through should have touched. Held classes are
 * skipped whole rather than partly — a hold that removed the oldest half of a class would preserve
 * nothing worth preserving.
 */
export async function sweepRetention(
  gateway: RetentionGateway,
  policy: RetentionPolicy,
  holds: readonly LegalHold[],
  by: string,
  now: Date = new Date()
): Promise<Sweep> {
  const removals: Removal[] = [];
  const held: { retentionClass: RetentionClass; holds: readonly string[] }[] = [];
  let auditFloor: number | undefined;

  for (const retentionClass of RETENTION_CLASSES) {
    const heldBy = holdsOver(retentionClass, holds);
    if (heldBy.length > 0) {
      held.push({ retentionClass, holds: heldBy.map((hold) => hold.id) });
      continue;
    }

    const before = cutoffFor(policy.periods[retentionClass], now);
    for (const one of RETAINED.filter((table) => table.retentionClass === retentionClass)) {
      if (one.table === CHAINED_TABLE) {
        const { removed, floor } = await gateway.trimAuditPrefix(before, by);
        if (floor != null) auditFloor = floor;
        removals.push({ table: one.table, retentionClass, removed, before });
        continue;
      }
      removals.push({
        table: one.table,
        retentionClass,
        removed: await gateway.remove(one.table, one.stamp, before, one.only),
        before,
      });
    }
  }

  return {
    at: now,
    by,
    removals,
    removed: removals.reduce((sum, removal) => sum + removal.removed, 0),
    held,
    ...(auditFloor != null ? { auditFloor } : {}),
  };
}

/** Why a period was refused, in a sentence naming the bound. Undefined when it is usable. */
export function periodRefusal(days: unknown): string | undefined {
  if (typeof days !== 'number' || !Number.isInteger(days)) {
    return 'A retention period is a whole number of days.';
  }
  if (days < MIN_PERIOD_DAYS) {
    return `A retention period of ${String(days)} days would delete records as fast as they are written. The shortest is ${String(MIN_PERIOD_DAYS)} day.`;
  }
  if (days > MAX_PERIOD_DAYS) {
    return `${String(days)} days is longer than this app can meaningfully promise. The longest is ${String(MAX_PERIOD_DAYS)} days, which is a hundred years.`;
  }
  return undefined;
}

/** Why a hold was refused. A hold with no reason and no scope is a hold nobody can act on later. */
export function holdRefusal(reason: unknown, covers: unknown): string | undefined {
  if (typeof reason !== 'string' || reason.trim().length < 10) {
    return 'A legal hold needs a reason of at least ten characters. Whoever lifts it will not be whoever placed it.';
  }
  if (!Array.isArray(covers) || covers.length === 0) {
    return `A legal hold has to cover at least one of ${RETENTION_CLASSES.join(', ')}.`;
  }
  const unknown = covers.filter((one) => !RETENTION_CLASSES.includes(one as RetentionClass));
  if (unknown.length > 0) {
    return `${unknown.map(String).join(', ')} is not something this app retains. The classes are ${RETENTION_CLASSES.join(', ')}.`;
  }
  return undefined;
}

/** The audit target for a hold, so the trail names what was held rather than only that something was. */
export function holdTarget(id: string): AuditTarget {
  return { kind: 'legal-hold', id };
}
