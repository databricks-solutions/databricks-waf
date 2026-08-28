// How many rows a retention sweep meets in each table it sweeps, from this app's own settings.
//
// `83` exists because sixteen of the twenty-two swept tables have no index led by the column the
// sweep filters and orders on. Sixteen indexes is sixteen write costs on every insert and sixteen
// objects to keep, and nothing said how many of them earn it. H1 is the worked example of building
// the rework before the reading: eight statements were named as past a cap, one was, and four of the
// eight had room to spare.
//
// The reading needs a volume, and a volume for *these* tables is not the one `history-volume.ts`
// derives. That module answers one question — how many revisions of one requirement's answer an
// install accrues — and four registers share the answer. A sweep meets twenty-two tables arranged
// four different ways: per requirement, per run, per plan, and per month. A single row count applied
// to all of them would report `month_publications` and `attestations` as the same size, and they
// differ by three orders of magnitude, which is the whole of what decides an index.
//
// # What is derived and what is assumed
//
// Every count below is one or the other, and each says which. Derived means the arithmetic runs on a
// constant this app ships: a retention period from `DEFAULT_PERIOD_DAYS`, a cadence from
// `cadenceDaysFor`, the catalogue's own size. Assumed means nothing in the app bounds it and a number
// had to be chosen — how often an install runs an assessment, how many people leave notes.
//
// The distinction is not decoration. An index justified by a derived count is justified by the app's
// own policy and will hold for any install running it. An index justified by an assumed count holds
// for an install that works the way the assumption says, and the published table has to say so, or a
// reader takes a number about a weekly cadence as a number about theirs. This is the same rule
// `notesEach` follows in the history benchmark, moved into the type so it cannot be left off.
//
// The run cadence is the assumption that carries the most weight here — nine of the twenty-two tables
// are sized from it — and it is emphatically not read from `resources/scheduled-scan.yml`. That file
// is this repository's bundle, `readCadence` parses daily and monthly expressions too, and a customer
// sets their own. Weekly is stated below as a choice, with what a daily install would multiply by.

import { cadenceDaysFor } from '../attest/attestation.js';
import { DEFAULT_PERIOD_DAYS, RETAINED } from './retention.js';

/**
 * How often an install starts an assessment run. **Assumed**, not read from anything.
 *
 * Weekly, which is what this repository's own bundle schedules and what the operating cadence in
 * `docs/` describes. Neither makes it a fact about an install: the schedule is a customer's to set,
 * and `readCadence` accepts daily and monthly. A daily install multiplies every run-shaped count
 * below by seven, and the published table says so rather than leaving a reader to work it out.
 */
export const RUN_CADENCE_DAYS = 7;

/**
 * Pillars a review confirms or skips, which is how many rows one review puts in `pillar_reviews`.
 *
 * Derived, in the sense that matters: the table is unique on `(review_id, pillar_id)`, so a review
 * cannot exceed the catalogue's pillar count, and the catalogue's pillar count is passed in rather
 * than written here for the reason `history-volume.ts` takes `requirements` as a parameter.
 */
export const PILLARS = 7;

/** Days in a published month, for turning a retention period into a count of publications. */
const DAYS_PER_MONTH = 2555 / 84;

/**
 * Whether a count rests on a constant this app ships or on a choice somebody made.
 *
 * A field rather than a note in the prose, because the published table prints it per row and a
 * measurement whose provenance is optional is one where the assumed rows quietly read as derived.
 */
export type Provenance = 'derived' | 'assumed';

/** One swept table, how many rows a sweep meets in it, and where that number came from. */
export interface SweptVolume {
  readonly table: string;
  /** Rows at the volume this app's settings and the stated assumptions imply. */
  readonly rows: (requirements: number) => number;
  readonly provenance: Provenance;
  /** The arithmetic, in the words a reader needs to check it. */
  readonly derives: string;
}

/** Assessment runs retained, at the assumed cadence over the approved assessment period. */
export function assessmentRuns(): number {
  return Math.ceil(DEFAULT_PERIOD_DAYS.assessment / RUN_CADENCE_DAYS);
}

/** Advisory runs retained. The shortest period here, and the one that keeps its tables small. */
export function advisoryRuns(): number {
  return Math.ceil(DEFAULT_PERIOD_DAYS.advisory / RUN_CADENCE_DAYS);
}

/** Revisions of one requirement's answer, over the governance period at the shortest cadence. */
export function revisionsEach(): number {
  return Math.ceil(DEFAULT_PERIOD_DAYS.governance / cadenceDaysFor('critical'));
}

/**
 * Plans an install holds, and actions on each.
 *
 * A plan is a board somebody opens; an action names one or two requirements rather than a plan
 * holding one action per requirement. Both are the shape `history-fixtures.ts` already seeds and both
 * are assumptions — nothing in the app bounds how many boards a customer opens.
 */
export const ACTIONS_PER_PLAN = 12;

function plans(requirements: number): number {
  return Math.max(1, Math.ceil(requirements / ACTIONS_PER_PLAN));
}

/**
 * The twenty-two swept tables, sized.
 *
 * Ordered as `RETAINED` orders them, so a reader can hold the two side by side, and held against it
 * by `retention-volume.test.ts`: a table added to the sweep with no volume here is a table `83`'s
 * successor would measure at zero rows and record as needing no index.
 */
export const SWEPT_VOLUMES: readonly SweptVolume[] = [
  {
    table: 'assessment_setup_drafts',
    rows: () => 12 * 8,
    provenance: 'assumed',
    derives: '12 assessments, each with a draft saved by 8 authors — the widest a setup surface holds',
  },
  {
    table: 'scans',
    rows: () => assessmentRuns(),
    provenance: 'assumed',
    derives: `one completed scan per assessment run: ceil(${String(DEFAULT_PERIOD_DAYS.assessment)} / ${String(RUN_CADENCE_DAYS)})`,
  },
  {
    table: 'imported_evidence',
    rows: () => assessmentRuns(),
    provenance: 'assumed',
    derives: 'one collection imported per assessment run, which is the cadence an offline install uploads at',
  },
  {
    table: 'attestations',
    rows: (requirements) => requirements * revisionsEach(),
    provenance: 'derived',
    derives: 'every scored requirement answered on the shortest cadence for the governance period',
  },
  {
    table: 'decisions',
    rows: (requirements) => requirements * revisionsEach(),
    provenance: 'derived',
    derives: 'one decision per attestation — what was accepted, planned or claimed fixed',
  },
  {
    table: 'improvement_plans',
    rows: (requirements) => plans(requirements),
    provenance: 'assumed',
    derives: `one board per ${String(ACTIONS_PER_PLAN)} requirements`,
  },
  {
    table: 'improvement_actions',
    rows: (requirements) => plans(requirements) * ACTIONS_PER_PLAN * revisionsEach(),
    provenance: 'assumed',
    derives: `${String(ACTIONS_PER_PLAN)} actions per board, each revised once per governance cadence`,
  },
  {
    table: 'validation_attempts',
    rows: (requirements) => plans(requirements) * ACTIONS_PER_PLAN * revisionsEach(),
    provenance: 'assumed',
    derives: 'one attempt per action revision, all but the newest answered',
  },
  {
    table: 'accepted_risks',
    rows: (requirements) => requirements * revisionsEach(),
    provenance: 'derived',
    derives: 'the register arithmetic, as for attestations — an acceptance expires on the same table',
  },
  {
    table: 'applicability_decisions',
    rows: (requirements) => requirements * revisionsEach(),
    provenance: 'derived',
    derives: 'the register arithmetic, as for attestations — a scoping decision expires on the same table',
  },
  {
    table: 'notes',
    rows: (requirements) => requirements * revisionsEach(),
    provenance: 'assumed',
    derives: 'as many notes about a requirement as there are answers to it — the assumption 46a states',
  },
  {
    table: 'pillar_reviews',
    rows: () => assessmentRuns() * PILLARS,
    provenance: 'assumed',
    derives: `${String(PILLARS)} pillars confirmed or skipped per review, one review per assessment run`,
  },
  {
    table: 'review_answers',
    rows: (requirements) => requirements * revisionsEach(),
    provenance: 'assumed',
    derives: 'one review answer per attestation, which is what the unique index on the pair allows',
  },
  {
    table: 'assessment_results',
    rows: () => assessmentRuns(),
    provenance: 'assumed',
    derives: 'one finalised result per review',
  },
  {
    table: 'assessment_reviews',
    rows: () => assessmentRuns(),
    provenance: 'assumed',
    derives: 'one review per completed run, which the unique index on run_id enforces',
  },
  {
    table: 'month_publications',
    rows: () => Math.ceil(DEFAULT_PERIOD_DAYS.governance / DAYS_PER_MONTH),
    provenance: 'derived',
    derives: 'one publication per month over the governance period — the longest-lived record here',
  },
  {
    table: 'run_attempts',
    rows: () => (assessmentRuns() + advisoryRuns()) * 2,
    provenance: 'assumed',
    derives: 'two attempts per run, so a retry and a takeover are both in the count',
  },
  {
    table: 'plan_extracts',
    rows: () => advisoryRuns() * 40 * 3,
    provenance: 'assumed',
    derives: '40 shapes per advisory run, three executions each — the shape 33n records',
  },
  {
    table: 'advisories',
    rows: () => advisoryRuns(),
    provenance: 'derived',
    derives: `one advisory per advisory run: ceil(${String(DEFAULT_PERIOD_DAYS.advisory)} / ${String(RUN_CADENCE_DAYS)})`,
  },
  {
    table: 'runs',
    rows: () => assessmentRuns() + advisoryRuns(),
    provenance: 'assumed',
    derives: 'assessment runs over the assessment period plus advisory runs over the advisory period',
  },
  {
    table: 'run_checkpoints',
    rows: () => assessmentRuns() * 60,
    provenance: 'assumed',
    derives: '60 signals reached per run, kept only so a retry does not read them again',
  },
  {
    table: 'audit_events',
    rows: (requirements) => requirements * revisionsEach() * 2,
    provenance: 'assumed',
    derives: 'two events recorded per governance record written — the write, and the read that preceded it',
  },
];

/** The sweep's tables with no volume, and the volumes naming no swept table. Empty is the invariant. */
export function unsized(): { readonly unsized: readonly string[]; readonly unswept: readonly string[] } {
  const swept = new Set(RETAINED.map((one) => one.table));
  const sized = new Set(SWEPT_VOLUMES.map((one) => one.table));
  return {
    unsized: [...swept].filter((table) => !sized.has(table)).sort((a, b) => a.localeCompare(b)),
    unswept: [...sized].filter((table) => !swept.has(table)).sort((a, b) => a.localeCompare(b)),
  };
}
