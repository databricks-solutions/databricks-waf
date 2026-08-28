// How many governance records this app's own policy implies, and which reads load all of them.
//
// `GAP-025` says several stores read a record's whole history into application memory and filter it
// there. That is true of the code, and on its own it is a shape rather than a defect: a read of forty
// rows does not care. What decides whether it matters is the number of rows the app's own settings
// allow to accumulate, and until something states that number the rework has no size and no priority.
//
// So this module states it, and it derives rather than declares it. Two constants the app already
// ships decide the volume between them:
//
//   `DEFAULT_PERIOD_DAYS.governance` — 2,555 days, seven years, the approved retention default for
//   what somebody asserted or decided. Nothing is removed before it, and the sweep that could remove
//   it afterwards runs when an administrator asks (see `retention.ts`).
//
//   `cadenceDaysFor('critical')` — 90 days, the shortest interval at which an answer must be given
//   again. An attestation, an acceptance and a parked decision all expire on that table, so each is
//   re-recorded roughly that often for as long as somebody keeps the requirement answered.
//
// A requirement answered on the shortest cadence for the full retention period therefore accrues
// `ceil(2555 / 90)` = 29 records, and an install accrues that per scored requirement. That is the
// figure the benchmark measures at, and it is the app's own arithmetic rather than an estimate of how
// customers behave. What the arithmetic assumes is stated on `HistoryVolume` below.

import { DEFAULT_PERIOD_DAYS } from '../admin/retention.js';
import { cadenceDaysFor } from '../attest/attestation.js';

/** Seven years, the approved default for records of what somebody asserted or decided. */
export const GOVERNANCE_DAYS = DEFAULT_PERIOD_DAYS.governance;

/** 90 days: the shortest cadence in the table attestations, acceptances and parked decisions share. */
export const SHORTEST_CADENCE_DAYS = cadenceDaysFor('critical');

/**
 * Revisions one requirement accrues under the retention default, at the cadence that expires soonest.
 *
 * The ceiling rather than the floor, because the record that renews an expiring answer is written
 * before the old one lapses, not after.
 */
export const REVISIONS_PER_REQUIREMENT = Math.ceil(GOVERNANCE_DAYS / SHORTEST_CADENCE_DAYS);

/**
 * How far past the derived volume a read has to keep working.
 *
 * The same margin `scale.ts` holds the estate-scaled statements to, for the same reason: a volume
 * derived from today's defaults is a volume an install exceeds the moment an administrator sets a
 * longer period, and `MAX_PERIOD_DAYS` allows a hundred years. Two is the smallest multiple that
 * means anything — a read that only passes at exactly 1.0 fails on the first configuration change.
 */
export const GROWTH_MARGIN = 2;

/**
 * A volume to measure a read at, and what it assumes.
 *
 * `assumes` is on the record rather than in a comment because these numbers travel into a published
 * table, and a volume whose assumption is not beside it is a number a reader will quote as a
 * measurement of their own install.
 */
export interface HistoryVolume {
  /** Short name, used as the column heading in the published table. */
  readonly name: string;
  /** Distinct records — one per scored requirement, per plan, per assessment, depending on the read. */
  readonly records: number;
  /** Revisions of each. One means the record was written once and never renewed. */
  readonly revisionsEach: number;
  readonly assumes: string;
}

/**
 * The three volumes, from the arithmetic above and the catalogue's own size.
 *
 * `first` exists to separate two costs the largest volume cannot tell apart: a read that is slow
 * because it loads a lot and one that is slow before it loads anything. `derived` is what the app's
 * settings imply. `growth` is `derived` at the margin above.
 *
 * @param requirements scored requirements in the catalogue, counted from the catalogue rather than
 * written down here — `check:counts` already holds that number against the tree, and a second copy of
 * it in this file is a number that goes stale silently.
 */
export function volumes(requirements: number): readonly HistoryVolume[] {
  return [
    {
      name: 'first',
      records: requirements,
      revisionsEach: 1,
      assumes: 'every scored requirement answered once and never renewed',
    },
    {
      name: 'derived',
      records: requirements,
      revisionsEach: REVISIONS_PER_REQUIREMENT,
      assumes:
        `every scored requirement answered on the ${String(SHORTEST_CADENCE_DAYS)}-day cadence for the ` +
        `full ${String(GOVERNANCE_DAYS)}-day governance retention default`,
    },
    {
      name: 'growth',
      records: requirements,
      revisionsEach: REVISIONS_PER_REQUIREMENT * GROWTH_MARGIN,
      assumes: `the derived volume at the ${String(GROWTH_MARGIN)}x margin scale.ts holds a statement to`,
    },
  ];
}

/** Rows one volume puts in front of a read that loads every revision of every record. */
export function rowsIn(volume: HistoryVolume): number {
  return volume.records * volume.revisionsEach;
}

/**
 * One read this benchmark times, and which of the two groups it is in.
 *
 * `loadsWholeTable` is `GAP-025`'s claim about the read, narrowed to the part that decides the cost:
 * not whether it reduces in TypeScript — every one of these does — but whether the rows it reduces
 * are the whole table or a `where` clause's worth. It is a field rather than prose because the
 * benchmark reports the two groups separately, and a budget with no narrowed read in it could not
 * tell a slow read from a slow database.
 *
 * Each `loads` is read off the method rather than off the gap register, and two of them were wrong
 * when this file was first written: `applicability.for` narrows by `control_id` in SQL, and there is
 * no `PostgresScanStore` on the shape the controls first named.
 */
export interface HistoryRead {
  readonly id: string;
  /** What the store method is called, as a reader would find it in the tree. */
  readonly method: string;
  /** What it loads before it decides anything. */
  readonly loads: string;
  /** The same thing in three words, for the table's second column. */
  readonly fetches: string;
  /**
   * Whether this read is one of the controls rather than one of the subjects.
   *
   * Separate from what it fetches, and it did not used to be: while every subject read its whole
   * table, one flag answered both questions. `46b` narrowed one of them, and a flag that had been
   * two facts wearing one name would then have labelled a narrowed subject as a control.
   */
  readonly control: boolean;
}

/**
 * The seven reads measured, and the three measured as controls.
 *
 * Every one of these is a Postgres implementation; the in-memory stores are not measured, because a
 * store that holds the records in a `Map` has no read cost worth a budget and is not what a customer
 * runs.
 *
 * Five subjects and two controls came from `GAP-025` and were measured by `46a`. `validate.outstanding`
 * and `notes.counts` are `36i`'s, added for the same reason and answered the same way: the row named
 * eight reads that reduce in TypeScript and nobody had said which of them cost anything.
 *
 * The controls are `applicability.for`, `attestations.historyFor` and `validate.for`, and each is the
 * read either side of one of the subjects: same table, same volume, same reduction, one `where` clause
 * apart. A control on a different table would leave a slow subject and a slow database
 * indistinguishable; these three cannot, because the rows they narrow to are in the table the subject
 * beside them just read whole.
 */
export const HISTORY_READS: readonly HistoryRead[] = [
  {
    id: 'definitions.all',
    method: 'PostgresDefinitionStore.all',
    loads: 'every version body of every assessment definition, then groups and sorts them',
    fetches: 'the whole table',
    control: false,
  },
  {
    id: 'applicability.all',
    method: 'PostgresApplicabilityStore.all',
    loads: 'every revision of every applicability decision, then keeps the highest of each',
    fetches: 'the whole table',
    control: false,
  },
  {
    id: 'risks.all',
    method: 'PostgresRiskStore.all',
    loads: 'every revision of every accepted risk, then keeps the highest of each',
    fetches: 'the whole table',
    control: false,
  },
  {
    id: 'attestations.current',
    method: 'PostgresEventLog.current, through PostgresAttestationStore',
    loads: 'every attestation ever recorded, then keeps the newest per requirement',
    fetches: 'the whole table',
    control: false,
  },
  {
    id: 'improvements.actionsFor',
    method: 'PostgresImprovementStore.actionsFor',
    loads:
      'every revision of the actions that have ever named this requirement, by two statements, ' +
      'then keeps the highest of each and filters by requirement',
    fetches: 'the actions naming one requirement',
    control: false,
  },
  {
    id: 'validate.outstanding',
    method: 'PostgresValidationStore.outstanding',
    loads:
      'the attempts with no answered sibling, by `not exists`, then keeps the highest revision of ' +
      'each and drops any whose body carries an answer',
    fetches: 'the attempts nobody has answered',
    control: false,
  },
  {
    id: 'notes.counts',
    method: 'PostgresNoteStore.counts',
    loads: 'one row per subject, by `group by`, then parses each `bigint` into a number',
    fetches: 'one row per subject',
    control: false,
  },
  {
    id: 'applicability.for',
    method: 'PostgresApplicabilityStore.for',
    loads: 'one requirement’s decisions, by `where control_id = $1`, then keeps the highest of each',
    fetches: 'one requirement’s rows — **control**',
    control: true,
  },
  {
    id: 'attestations.historyFor',
    method: 'PostgresEventLog.historyFor, through PostgresAttestationStore',
    loads: 'one requirement’s attestations, by `where control_id = $1`, then orders them',
    fetches: 'one requirement’s rows — **control**',
    control: true,
  },
  {
    id: 'validate.for',
    method: 'PostgresValidationStore.for',
    loads: 'one action’s attempts, by `where action_id = $1`, then keeps the highest revision of each',
    fetches: 'one action’s rows — **control**',
    control: true,
  },
];
