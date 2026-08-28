// The assessment as a file somebody can send to somebody who was not in the room.
//
// Two formats, one source. CSV is for the reader who is going to filter to the failures, sort by
// severity and hand rows to owners — a spreadsheet, in other words, which is what platform teams
// actually plan work in. JSON is for the reader who is going to diff two runs or feed a ticket
// tracker, and it keeps the structure the CSV has to flatten.
//
// Both are built here rather than in the route, because the interesting decisions are about what a
// figure means out of context and none of them are HTTP.
//
// The rule the shapes follow: a row that has left the app has to carry enough to be argued with.
// A bare "SEC-01-02, fail" in a spreadsheet three weeks later is unanswerable — the recipient
// cannot tell what was looked at, how much of the estate it covered, whose permissions it was read
// with, or whether the requirement was measured at all rather than answered by a colleague. So
// every row carries the run's identity and date, the coverage, and the attribution. It is
// repetitive down a column and that repetition is the point: a spreadsheet has no header block,
// and a reader who filters to twelve rows has to still be looking at twelve complete statements.
//
// Which columns and fields a file carries depends on who it is for — see `variant.ts`, which also
// says why a variant may narrow the columns and may never drop a row.

import type { Catalogue, CatalogueControl } from '../catalogue/catalogue.js';
import type { Coverage } from '../collect/signal.js';
import type { Provenance } from '../collect/provenance.js';
import { classOf } from '../resolve/evidence-class.js';
import type { Evidence, Finding } from '../resolve/finding.js';
import { describeItem } from '../resolve/finding.js';
import type { Axis } from '../scan/identity.js';
import type { Scan, ScanTrigger } from '../scan/scan.js';
import type { FinalisationPayload } from '../../shared/api/contract.js';
import type { Disposition } from '../decide/decision.js';
import type { Standing, Standings } from '../decide/standing.js';
import type { ApplicabilityLever } from '../apply/applicability.js';
import type { Exposure } from '../apply/apply.js';
import { csv } from './csv.js';
import {
  carriesEvidence,
  carriesProvenance,
  DEFAULT_VARIANT,
  VARIANT_SHAPES,
  type ExportColumn,
  type ExportVariant,
} from './variant.js';

/**
 * The version of the file format, not of the app.
 *
 * Present because the first thing anybody does with a machine-readable export is write something
 * that reads it, and the second thing we do is change the shape. A consumer that can check one
 * integer can refuse a file it does not understand instead of silently mapping the wrong column.
 * Bump it when a field is removed or its meaning changes; adding one is not a break.
 *
 * 2 removed `generatedAt`, which is a break by that rule and the point of the change: it was the
 * only field that differed between two exports of one run, so no recipient could check that the
 * file they hold is the file this app produced. See ADR 0050.
 *
 * 3 added `variant`, and is a break for the reason adding a field usually is not: three of the four
 * variants are subsets, so from this version a document may legitimately carry fewer fields per
 * finding than the one before it. A consumer that reads `documentVersion` and not `variant` would
 * read a shorter file as a run with less recorded about it. ADR 0056.
 *
 * 4 replaces the ambiguous flat catalogue version/fingerprint with a public methodology identity
 * and an explicitly technical catalogue block. Old runs carry `classification: pre-release`; a
 * reader never infers Version 1 from the catalogue revision that happens to be current now.
 */
export const DOCUMENT_VERSION = 4;

export const DOCUMENT_KIND = 'databricks-waf-assessment';

/** How each unmeasured reason reads to somebody who does not know the app's vocabulary. */
const UNMEASURED: Readonly<Record<NonNullable<Finding['unmeasured']>, string>> = {
  attestation: 'no telemetry can answer this; a person has to',
  unreachable: 'the platform does not authorise any install of this app to read it',
  unbuilt: 'this app does not read this yet',
  unreadable: 'the app asked and did not get an answer',
  disabled: 'this check is switched off in this install, so this run did not score it',
};

/**
 * What to do about a requirement nothing measured, for a column headed `next_step`.
 *
 * Separate from `UNMEASURED` above because the two columns ask different questions and were answering
 * with one string: `why_unmeasured` wants the reason and `next_step` wants an instruction, and a reader
 * filtering a spreadsheet to the rows with a step found "no telemetry can answer this; a person has to"
 * in the cell they were going to work from. Where the finding carries its own remedy that still wins —
 * a resolver that knows why it could not read something knows better than a table.
 */
const STEP_WHEN_UNMEASURED: Readonly<Record<NonNullable<Finding['unmeasured']>, string>> = {
  attestation: 'Answer this in the questionnaire, with the name of whoever answered.',
  unreachable: 'Nothing, until the platform exposes it. No install of this app can read it.',
  unbuilt: 'Nothing. Answer it in the questionnaire if you need it recorded before then.',
  unreadable: 'Re-run the scan. If it persists, check what this app is permitted to read.',
  disabled: 'Switch the check back on if this requirement should apply here.',
};

// The kind of identity, not whose. `ran_as` names it, and this column says nothing that column does
// not carry: a scheduled run authenticates as whichever principal the customer created for it. This
// said "the app's service principal" for as long as nothing ever set the mode to that value.
const MODE: Readonly<Record<Scan['stamp']['executionMode'], string>> = {
  'on-behalf-of-user': 'the identity that started it',
  'service-principal': 'a service principal',
};

const TRIGGER: Readonly<Record<ScanTrigger, string>> = {
  interactive: 'a person',
  scheduled: 'a schedule',
};

/**
 * The decision words, in a file's terms rather than a form's.
 *
 * Not the labels the UI uses. "Fixed it" is right above a radio button and wrong in a spreadsheet
 * cell, where the same string is read as a statement about the requirement rather than as the
 * choice somebody made about it.
 */
const DISPOSITION: Readonly<Record<Disposition, string>> = {
  fixed: 'reported fixed',
  deferred: 'fix planned',
  accepted: 'risk accepted',
  reopened: 'reopened',
};

/**
 * What the run made of the decision, spelled out.
 *
 * `contradicted` is the reason these columns are in the file at all: a recipient filtering a
 * spreadsheet for work that was reported done and did not hold should find it in one filter, and
 * "contradicted" alone would need explaining to whoever reads the sheet next.
 */
const STANDING: Readonly<Record<Standing, string>> = {
  current: 'holding',
  due: 'holding, review date close',
  lapsed: 'lapsed, back on the list',
  unverified: 'not yet checked by a run',
  confirmed: 'confirmed by this run',
  contradicted: 'this run still finds it unmet',
  settled: 'no longer unmet',
  withdrawn: 'withdrawn',
};

/**
 * How each applicability lever reads in a file, as the thing the customer decided rather than the
 * outcome it produced. The outcome is already in the `outcome` column; this is why it reads that way.
 */
const LEVER: Readonly<Record<ApplicabilityLever, string>> = {
  'not-applicable': 'not applicable, by customer decision',
  disabled: 'check disabled by customer',
};

/** What a run made of a customer's applicability decision: it took the requirement out, or it lapsed. */
interface AppliedNote {
  readonly phrase: string;
  /**
   * The decision's own id, on both an exclusion and a lapse.
   *
   * The exposure carries it for each, and the file promised it and dropped it: a reader reconciling the
   * export against the applicability register had no join key and was told they had one.
   */
  readonly decisionId: string;
  readonly owner: string;
  readonly reason: string;
}

/**
 * The applicability decisions that bear on a row, by requirement, from the score's exposure.
 *
 * An excluded requirement carries its lever, owner and reason. A lapsed one carries only the lever and
 * the reading that set it aside — the exposure records no owner or reason for a lapse, and a file that
 * invented them would say more than the field under it. Both are shown, because a reader reconciling the
 * file against the score needs to tell a requirement a customer took out from one whose exclusion the
 * reading has put back.
 */
function exposureIndex(exposure: Exposure | undefined): Map<string, AppliedNote> {
  const index = new Map<string, AppliedNote>();
  for (const one of exposure?.excluded ?? []) {
    index.set(one.controlId, {
      phrase: LEVER[one.lever],
      decisionId: one.decisionId,
      owner: one.owner,
      reason: one.reason,
    });
  }
  for (const one of exposure?.lapsed ?? []) {
    index.set(one.controlId, {
      // Not "back in the score", which says it was out of it. A decision recorded while nothing had
      // measured the requirement, and read as failing by the first scan to reach it, never excluded
      // anything — and this phrase cannot tell that case from a pass that later regressed.
      phrase: `${LEVER[one.lever]} — not applied, this run reads ${one.reading}, so it is in the score`,
      decisionId: one.decisionId,
      owner: '',
      reason: '',
    });
  }
  return index;
}

export interface ExportOptions {
  readonly scan: Scan;
  /**
   * The requirement text, for the two things it is read for: a control's own criteria and fix, and
   * a pillar's title.
   *
   * Narrowed to those rather than taking the whole catalogue, so the signature says what the file
   * is built from — and so a test does not have to construct a version, a fingerprint and a
   * principle tree to assert on a column.
   */
  readonly catalogue: Pick<Catalogue, 'controls' | 'pillars'>;
  /**
   * What somebody decided about these findings, judged against this run.
   *
   * Passed in already judged, and only for the run they were judged against — the caller checks
   * that, because a standing is a comparison between a decision and one particular run. A file
   * exported for a six-week-old scan carries no decision columns rather than columns judged against
   * a scan the file does not describe.
   *
   * Empty for an install with nothing bound to keep decisions, which is the same file this produced
   * before decisions existed.
   */
  readonly decisions?: readonly Standings[];
  /**
   * Where the run stands with its review, as the payload the surfaces read.
   *
   * Absent means this app cannot say — an install that keeps no reviews — and the file leaves the
   * column blank and the block out rather than reporting a review nobody did. Like `decisions`, this
   * is a fact that moves after the run: a file taken before the review was finished and one taken
   * after are two true files of the same run, and their digests differ. That is what an export is
   * for, and ADR 0072 draws the line — a published month is frozen, an export answers what is true
   * now.
   */
  readonly finalisation?: FinalisationPayload<Date>;
  /**
   * Who the file is for, which decides its columns and how much of each finding it carries.
   *
   * Absent is the complete file, so every caller written before variants existed gets the document it
   * always got. See `variant.ts`.
   */
  readonly variant?: ExportVariant;
}

/**
 * Coverage in one cell.
 *
 * The reach is included because it is the difference between "every workspace in the account" and
 * "this workspace", and a recipient who assumes the first when the truth is the second will
 * report the wrong thing to their own management.
 */
export function coverageCell(coverage: Coverage): string {
  const reach = coverage.reach == null ? '' : ` of the ${coverage.reach}`;
  if (coverage.mode === 'complete') return `complete${reach}`;
  if (coverage.examined == null || coverage.population == null) return `sampled${reach}`;
  return `sampled, ${String(coverage.examined)} of ${String(coverage.population)}${reach}`;
}

/** Who read it and from where, in one cell. Empty when the finding rests on nothing observed. */
export function attributionCell(provenance: Provenance | undefined): string {
  if (provenance == null) return '';
  const where = provenance.from == null ? '' : `, from ${provenance.from}`;
  return `${provenance.actor} (${provenance.authority})${where}`;
}

/**
 * The one thing to do about this finding.
 *
 * The catalogue's remediation when the app measured the requirement and found it unmet, and the
 * finding's own remedy when it could not measure it at all. Never both: they answer the same
 * question at different stages, and a cell holding two instructions is a cell a reader skips.
 */
function nextStepCell(finding: Finding, control: CatalogueControl | undefined): string {
  if (finding.outcome === 'unmeasurable')
    return finding.remedy?.says ?? STEP_WHEN_UNMEASURED[finding.unmeasured ?? 'unreadable'];
  if (finding.outcome === 'fail' || finding.outcome === 'partial') return control?.remediation?.summary ?? '';
  return '';
}

/**
 * The review in one cell, and the only place a spreadsheet can say it.
 *
 * Four states rather than two, because a review can be finished with pillars nobody looked at, and a
 * cell reading `reviewed` on a run with three skips would be the file claiming more than the record.
 * Which pillars were skipped is in the JSON document's `review` block; a cell has no room for names
 * and a count of them would not say which.
 *
 * Blank where there is no record, which is an install that keeps no reviews rather than a run nobody
 * reviewed — the same distinction `started_by` leaves blank for.
 */
function reviewCell(finalisation: FinalisationPayload<Date> | undefined): string {
  if (finalisation == null) return '';
  if (!finalisation.finalised) {
    return `review unfinished (${String(finalisation.recorded)} of ${String(finalisation.expected)} pillars)`;
  }
  const result = finalisation.resultId == null ? 'finalised' : `published report ${finalisation.resultId}`;
  if (finalisation.confirmed === 0) return `${result}, no pillar confirmed`;
  // "every pillar" needs the two numbers to agree, and they do not always: a review finalises against
  // the catalogue as it stood, so a pillar added since leaves a finished review covering fewer than
  // there now are, with nothing skipped to show for it.
  if (finalisation.confirmed !== finalisation.expected) {
    return `${result}, ${String(finalisation.confirmed)} of ${String(finalisation.expected)} pillars confirmed`;
  }
  return `${result}, every pillar confirmed`;
}

/**
 * The review as the JSON document carries it: the fields, and a sentence saying what they are not.
 *
 * The skipped pillars by id and not as a count, because a recipient asking which parts of the score
 * nobody reviewed cannot get that from a number — the same reason the payload carries ids.
 */
function reviewBlock(finalisation: FinalisationPayload<Date>): Record<string, unknown> {
  return {
    ...(finalisation.resultId != null ? { finalResultId: finalisation.resultId } : {}),
    finalised: finalisation.finalised,
    pillarsRecorded: finalisation.recorded,
    pillarsExpected: finalisation.expected,
    pillarsConfirmed: finalisation.confirmed,
    pillarsSkipped: finalisation.skipped,
    answersCited: finalisation.cited,
    means: reviewCell(finalisation),
    answersCitedMeans:
      'Answers this run already held, copied when a pillar was confirmed. Not a count of the answers on ' +
      'record now, which moves after the review.',
    ...(finalisation.skipped.length > 0
      ? {
          pillarsSkippedMeans:
            'Nobody confirmed the answers of these pillars in this review. Their requirements are in the ' +
            'score on whatever the run measured.',
        }
      : {}),
    ...(finalisation.finalisedAt != null ? { finalisedAt: finalisation.finalisedAt.toISOString() } : {}),
    ...(finalisation.finalisedBy != null ? { finalisedBy: finalisation.finalisedBy } : {}),
  };
}

/** One finding, with everything a cell might be written from resolved once. */
interface Row {
  readonly scan: Scan;
  readonly variant: ExportVariant;
  readonly finding: Finding;
  readonly control: CatalogueControl | undefined;
  readonly decided: Standings | undefined;
  /** What the customer decided about whether this requirement is scored, from the exposure. */
  readonly applied: AppliedNote | undefined;
  readonly pillar: string;
  /** Where the run stands with its review. Absent where this app has no record either way. */
  readonly finalisation: FinalisationPayload<Date> | undefined;
  /**
   * The load-bearing evidence, which is the one whose coverage and attribution the outcome rests on.
   *
   * Detail evidence says where the gap is, and its attribution is the same anyway.
   */
  readonly first: Evidence | undefined;
}

/**
 * How each column is written, one function per column name.
 *
 * A map rather than a positional list, because four variants carry overlapping subsets of these and
 * the alternative is four lists of expressions that have to be kept saying the same thing. The
 * column order is `EXPORT_COLUMNS`, which every variant filters rather than reorders — so a reader
 * comparing two variants of one run reads the same columns in the same order, with some missing.
 */
const CELL: Readonly<Record<ExportColumn, (row: Row) => string>> = {
  run: (row) => row.scan.id,
  variant: (row) => row.variant,
  ran_at: (row) => row.scan.finishedAt.toISOString(),
  ran_as: (row) => row.scan.stamp.actor,
  ran_with: (row) => MODE[row.scan.stamp.executionMode],
  // Blank on runs from before this was recorded. Not filled in with the commoner case: a reader
  // filtering a year of exports for the unattended ones needs the blank to mean "not stated".
  started_by: (row) => (row.scan.stamp.trigger == null ? '' : TRIGGER[row.scan.stamp.trigger]),
  methodology_version: (row) => String(row.scan.stamp.publicMethodology?.publicVersion ?? ''),
  methodology_state: (row) => row.scan.stamp.publicMethodology?.state ?? 'pre-release',
  methodology_manifest: (row) => row.scan.stamp.publicMethodology?.manifestDigest ?? '',
  methodology_effective_date: (row) => row.scan.stamp.publicMethodology?.effectiveDate ?? '',
  catalogue_revision: (row) => row.scan.stamp.catalogueVersion,
  review: (row) => reviewCell(row.finalisation),
  // What produced the run, as the axis recorded it or as the reason it is not known — never blank
  // where a run tried to establish it and could not, which is a different fact from a run that never
  // carried it. See `scan/identity.ts`.
  app_build: (row) => axisCell(row.scan.stamp.identity?.build),
  scoring_method: (row) => axisCell(row.scan.stamp.identity?.methodology),
  pillar: (row) => row.pillar,
  requirement: (row) => row.finding.controlId,
  title: (row) => row.finding.title,
  outcome: (row) => row.finding.outcome,
  severity: (row) => row.finding.severity,
  reason: (row) => row.finding.outcomeReason ?? '',
  observed: (row) => row.finding.evidence.map((one) => one.observed).join('; '),
  expected: (row) =>
    row.finding.evidence
      .map((one) => one.expected)
      .filter((one) => one != null)
      .join('; '),
  coverage: (row) => coverageCell(row.finding.coverage),
  // What the outcome rests on: a reading this app took, a reading an administrator imported, or an
  // answer somebody gave. Beside `coverage` because they are the same question — how much of this
  // reader's trust the cell has earned — and a recipient who filters the file to `observed` is asking
  // to see only the part that was measured here.
  evidence: (row) => classOf(row.finding) ?? '',
  why_unmeasured: (row) => (row.finding.unmeasured == null ? '' : UNMEASURED[row.finding.unmeasured]),
  next_step: (row) => nextStepCell(row.finding, row.control),
  answered_by: (row) => row.finding.attested?.by ?? '',
  answered_at: (row) => row.finding.attested?.at.toISOString() ?? '',
  // When the answer stops counting, which is the question an auditor asks about a human answer and
  // the one `answered_at` cannot settle: an answer given fourteen months ago on an annual cadence is
  // in the file either way, and only this column says which side of its own expiry it is on.
  answer_review_by: (row) => row.finding.attested?.reviewBy.toISOString() ?? '',
  accountable: (row) => row.finding.attested?.owner ?? '',
  decision_id: (row) => row.decided?.decision.id ?? '',
  // What somebody chose to do about it, and what the run made of that choice. Blank on every row
  // for an install with no decisions recorded, which is the file this produced before they existed.
  // `decision_standing` is the column a recipient filters on: it is where "reported fixed, and this
  // run still finds it unmet" appears, and that row is the most actionable one in the file.
  decision: (row) => (row.decided == null ? '' : DISPOSITION[row.decided.decision.disposition]),
  decision_standing: (row) => (row.decided == null ? '' : STANDING[row.decided.standing]),
  decision_reason: (row) => row.decided?.decision.reason ?? '',
  decided_by: (row) => row.decided?.decision.decidedBy ?? '',
  decided_at: (row) => row.decided?.decision.decidedAt.toISOString() ?? '',
  decision_owner: (row) => row.decided?.decision.owner ?? '',
  // The date it comes back, not the date it was taken. Blank for a reported fix, which has no
  // date to come back on — the next run is what settles it.
  decision_date: (row) => row.decided?.decision.until?.toISOString() ?? '',
  // What the customer decided about whether this requirement is scored, and — for a lapse — why it is
  // back. Blank where no such decision bears on the row. The outcome column already reads
  // `not applicable` or `unmeasurable`; this is the column that says a person decided that, not the
  // estate.
  applicability: (row) => row.applied?.phrase ?? '',
  applicability_id: (row) => row.applied?.decisionId ?? '',
  applicability_owner: (row) => row.applied?.owner ?? '',
  applicability_reason: (row) => row.applied?.reason ?? '',
  read_as: (row) => attributionCell(row.first?.provenance),
  collected_at: (row) => row.first?.collectedAt.toISOString() ?? '',
  documentation: (row) => row.control?.remediation?.docUrl ?? row.control?.sourceRef ?? '',
  // The pages that fix it, one URL per named resource. This is the column that makes a row handed
  // to an owner actionable without them going looking: it is why the export is worth sending.
  // Empty for a requirement with nothing addressable behind it, or where the workspace directory
  // could not be read.
  where: (row) =>
    row.finding.evidence
      .flatMap((one) => one.at?.items ?? [])
      .flatMap((item) => (item.url != null ? [`${describeItem(item)}: ${item.url}`] : []))
      .join(' '),
};

/**
 * An identity axis as one cell: what it was, or why this build could not establish it.
 *
 * Never blank for a run that recorded the axis, because a blank in a column of digests reads as "the
 * same as the others" to somebody scanning it. A run from before identity was recorded has nothing to
 * say and says nothing, which is the one honest empty here.
 */
function axisCell(axis: Axis | undefined): string {
  if (axis == null) return '';
  return axis.id ?? (axis.unknown == null ? '' : `not established: ${axis.unknown}`);
}

/**
 * One row per finding, including the ones that are not applicable.
 *
 * Not filtered to failures, in any variant. A recipient checking whether a requirement was considered
 * needs to find it in the file and read "not applicable, and here is why" — an absent row is
 * indistinguishable from a requirement the app forgot, and that suspicion is the thing an
 * assessment cannot recover from. `variant.ts` says why that rule holds even for the file somebody
 * sends to a board.
 */
export function assessmentRows(options: ExportOptions): readonly (readonly string[])[] {
  const { scan, catalogue } = options;
  const variant = options.variant ?? DEFAULT_VARIANT;
  const columns = VARIANT_SHAPES[variant].columns;
  const controls = new Map(catalogue.controls.map((control) => [control.id, control]));
  const pillars = new Map(catalogue.pillars.map((pillar) => [pillar.id, pillar.title]));
  const decisions = decisionIndex(options.decisions);
  const applied = exposureIndex(scan.score.exposure);

  const rows = scan.findings.map((finding) => {
    const row: Row = {
      scan,
      variant,
      finding,
      control: controls.get(finding.controlId),
      decided: decisions.get(finding.controlId),
      applied: applied.get(finding.controlId),
      pillar: pillars.get(finding.pillarId) ?? finding.pillarId,
      finalisation: options.finalisation,
      first: finding.evidence.find((one) => one.bearing !== 'detail') ?? finding.evidence[0],
    };
    return columns.map((column) => CELL[column](row));
  });

  return [columns, ...rows];
}

export function assessmentCsv(options: ExportOptions): string {
  return csv(assessmentRows(options));
}

/**
 * The decisions that bear on a row, by requirement, with the withdrawn ones dropped.
 *
 * A withdrawn decision is history rather than a state of the requirement, and a spreadsheet cell
 * reading "reopened" beside a failure would be read as something being done about it.
 */
function decidedField(entry: Standings | undefined): Record<string, unknown> {
  if (entry == null) return {};
  const { decision } = entry;

  return {
    decision: {
      id: decision.id,
      choice: decision.disposition,
      means: DISPOSITION[decision.disposition],
      reason: decision.reason,
      decidedBy: decision.decidedBy,
      decidedAt: decision.decidedAt.toISOString(),
      ...(decision.owner != null ? { owner: decision.owner } : {}),
      ...(decision.until != null ? { until: decision.until.toISOString() } : {}),
      ...(decision.supersedes != null ? { supersedes: decision.supersedes } : {}),
      standing: entry.standing,
      standingMeans: STANDING[entry.standing],
    },
  };
}

function decisionIndex(decisions: readonly Standings[] | undefined): Map<string, Standings> {
  return new Map(
    (decisions ?? [])
      .filter((entry) => entry.standing !== 'withdrawn')
      .map((entry) => [entry.decision.controlId, entry])
  );
}

/**
 * The same assessment with its structure intact.
 *
 * Deliberately not the wire format the UI consumes. That one is shaped for a page that already
 * has the catalogue loaded, so its findings carry ids and no requirement text; a file has to
 * stand on its own, so each finding here carries the title, the judging criteria and the fix.
 *
 * Every field is a fact about the run or about what has been decided against it, and there is
 * deliberately nothing here about the export itself — no time it was taken, no identity that took it.
 * That is what makes the bytes a function of the record rather than of the request, which is what lets
 * a recipient check the file at all; who took it and when is in the trail, where it is a fact about a
 * person rather than a property of the assessment. Do not add a timestamp back. ADR 0050.
 */
export function assessmentDocument(options: ExportOptions): Record<string, unknown> {
  const { scan, catalogue } = options;
  const variant = options.variant ?? DEFAULT_VARIANT;
  const shape = VARIANT_SHAPES[variant];
  const controls = new Map(catalogue.controls.map((control) => [control.id, control]));
  const pillars = new Map(catalogue.pillars.map((pillar) => [pillar.id, pillar.title]));
  const decisions = decisionIndex(options.decisions);

  return {
    document: DOCUMENT_KIND,
    documentVersion: DOCUMENT_VERSION,
    /*
     * Which of the four this is, and what that means it carries.
     *
     * The sentence travels with the identifier because the reader who needs it is holding the file
     * with no access to this app: `variant: "executive"` alone is a word they would have to ask
     * somebody about, and the thing they would ask is which fields are missing and where the whole of
     * it is. `variant.ts` says why three of the four are narrower.
     */
    variant,
    variantMeans: shape.says,
    ...(shape.omits != null ? { variantOmits: shape.omits } : {}),
    run: {
      id: scan.id,
      startedAt: scan.startedAt.toISOString(),
      finishedAt: scan.finishedAt.toISOString(),
      /** `partial` means the run stopped short of its plan; `incompleteReason` says why. */
      state: scan.state,
      ranAs: scan.stamp.actor,
      ranWith: scan.stamp.executionMode,
      /*
       * Whether a person or a schedule started it. Omitted for a run recorded before this was
       * kept, rather than defaulted, so a reader cannot mistake silence for a person.
       *
       * Worth a field of its own because `ranWith` does not answer it: a scheduled run reaches
       * the app through the same on-behalf-of door as a browser, so its mode is
       * `on-behalf-of-user` while the identity is a service principal. ADR 0021.
       */
      ...(scan.stamp.trigger != null ? { startedBy: scan.stamp.trigger } : {}),
      covered: scan.stamp.scope.description,
      lookbackDays: scan.stamp.lookbackDays,
      ...(scan.stamp.assessedWorkspaces != null ? { assessedWorkspaces: scan.stamp.assessedWorkspaces } : {}),
      methodology:
        scan.stamp.publicMethodology == null
          ? { classification: 'pre-release' }
          : { classification: 'public', ...scan.stamp.publicMethodology },
      technicalCatalogue: {
        revision: scan.stamp.catalogueVersion,
        fingerprint: scan.stamp.catalogueFingerprint,
      },
      /*
       * Derived rather than stored, because the stamp does not carry it and a recipient needs it:
       * it is the difference between "no workspace has a policy" and "none of the two hundred
       * tables we looked at, out of forty thousand". Computed from the findings so it cannot
       * disagree with the rows below it.
       */
      anySampled: scan.findings.some((one) => one.coverage.mode === 'sampled'),
      ...(scan.requestedPillars != null ? { measuredPillars: scan.requestedPillars } : {}),
      ...(scan.incompleteReason != null ? { incompleteReason: scan.incompleteReason } : {}),
      ...(scan.notCarried != null ? { notCarried: scan.notCarried } : {}),
      ...(shape.produced ? producedField(scan) : {}),
    },
    estate: scan.estate,
    score: scan.score,
    /*
     * Where the run stood with its review when these bytes were built.
     *
     * Beside the score rather than inside `run`, because it is not a property of the run: the run is
     * finished and this is not, and a consumer reading `run` as the immutable half would be reading a
     * field that moves. Absent, rather than a false `finalised`, where this app keeps no reviews.
     *
     * `cited` is the count of answers the run already held, copied at confirm. It is not a count of
     * the answers on record now, and `means` says so in the file because a recipient has no other
     * way to know which of the two they are holding.
     */
    ...(options.finalisation != null ? { review: reviewBlock(options.finalisation) } : {}),
    findings: scan.findings.map((finding) => {
      const control = controls.get(finding.controlId);
      return {
        requirement: finding.controlId,
        pillar: pillars.get(finding.pillarId) ?? finding.pillarId,
        pillarId: finding.pillarId,
        principleId: finding.principleId,
        title: finding.title,
        outcome: finding.outcome,
        severity: finding.severity,
        coverage: finding.coverage,
        /*
         * What the outcome rests on, as a class.
         *
         * Absent for a requirement with nothing bearing on it, which is the honest answer for an
         * unmeasurable one — there is no class of evidence behind a finding that has no evidence.
         * Derived rather than stored, so it cannot disagree with the evidence listed below it.
         */
        ...(classOf(finding) != null ? { restsOn: classOf(finding) } : {}),
        ...(finding.outcomeReason != null ? { reason: finding.outcomeReason } : {}),
        ...(finding.unmeasured != null
          ? { unmeasured: { kind: finding.unmeasured, means: UNMEASURED[finding.unmeasured] } }
          : {}),
        ...(finding.remedy != null ? { remedy: finding.remedy } : {}),
        /*
         * The readings, for the files whose reader is going to check them.
         *
         * Absent from the executive variant and from nothing else. What is in here is estate detail —
         * table names, workspace names, counts, the text of an error a workspace returned — and it is
         * both the most useful part of the technical file and the part that makes a document nobody
         * technical is going to read twice as long. The verdict, the reason and the fix are above and
         * stay in every variant, so the shorter file still says what is wrong and what closes it.
         */
        ...(carriesEvidence(shape.detail)
          ? {
              evidence: finding.evidence.map((one) => ({
                signal: one.signal,
                observed: one.observed,
                ...(one.expected != null ? { expected: one.expected } : {}),
                bearing: one.bearing ?? 'outcome',
                // Written out rather than defaulted by the consumer, for the same reason `bearing` is: a
                // reader of the file should not have to know what this app's absent field means.
                evidenceClass: one.evidenceClass ?? 'observed',
                coverage: one.coverage,
                collectedAt: one.collectedAt.toISOString(),
                // Who took the reading and from where, for the two files whose reader is establishing
                // whether it can be relied on. Somebody working through a queue of fixes is not, and a
                // `readBy` on every reading in a file of two hundred is two hundred lines they scroll.
                ...(one.provenance != null && carriesProvenance(shape.detail) ? { readBy: one.provenance } : {}),
                // The resources named in `observed`, flattened to the ones that have a page. A consumer
                // building a ticket wants the URL; the prose above is already in `observed`.
                ...(one.at != null
                  ? {
                      links: one.at.items.flatMap((item) =>
                        item.url != null ? [{ label: describeItem(item), url: item.url }] : []
                      ),
                    }
                  : {}),
              })),
            }
          : {}),
        ...(finding.attested != null
          ? {
              answeredByAPerson: {
                ...finding.attested,
                at: finding.attested.at.toISOString(),
                reviewBy: finding.attested.reviewBy.toISOString(),
              },
            }
          : {}),
        /*
         * The decision as a record plus what this run made of it, not as a substitute for the
         * outcome above.
         *
         * Nested rather than flattened into the finding, so a consumer cannot read `standing:
         * "confirmed"` as the verdict on the requirement. The verdict is `outcome`; this is what
         * somebody undertook and whether the run bears it out.
         */
        ...decidedField(decisions.get(finding.controlId)),
        // What the app measured the requirement against. With the readings rather than with the
        // verdict, because the two are read together: the criteria is what makes an observation a
        // failure, and on its own it is a sentence about the catalogue that the title already implies.
        ...(control?.criteria != null && carriesEvidence(shape.detail) ? { judgedBy: control.criteria } : {}),
        ...(control?.rationale != null ? { whyItMatters: control.rationale } : {}),
        ...(control?.remediation != null ? { remediation: control.remediation } : {}),
        ...(control?.sourceRef != null ? { source: control.sourceRef } : {}),
      };
    }),
  };
}

/**
 * What produced the run, for the file whose reader is establishing whether the numbers can be relied
 * on rather than reading them.
 *
 * Four axes and the assessment the run answers to, each carried as what it was *or* as why this build
 * could not establish it — the distinction `scan/identity.ts` exists for, and the reason this is not a
 * block of digests with blanks in it. An axis nobody could establish is a fact about the run; a blank
 * is a reader guessing.
 *
 * Absent from a run recorded before identity was kept, rather than filled in: back-filling would put a
 * claim about what produced a run into the one document whose whole job is to be checkable.
 */
function producedField(scan: Scan): Record<string, unknown> {
  const identity = scan.stamp.identity;
  if (identity == null && scan.stamp.definition == null) return {};

  return {
    producedBy: {
      ...(identity != null
        ? {
            build: identity.build,
            scoringMethod: identity.methodology,
            recordEncoding: identity.record,
            /** Which surfaces answered. A run with no warehouse bound did not measure the same estate. */
            sources: identity.sources,
          }
        : {}),
      /*
       * The assessment this run answers to, at the version and measurement fingerprint it was started
       * under. The fingerprint rather than the version is what two runs have to share to be comparable
       * — a rename moves the version and not the question. ADR 0037.
       */
      ...(scan.stamp.definition != null ? { assessment: scan.stamp.definition } : {}),
    },
  };
}

/**
 * A filename that tells three downloads apart.
 *
 * The date, the run and the variant, because a reader comparing last month with this month has both
 * files in one folder and `export.csv (2)` tells them nothing about which is which — and because a
 * recipient checking a digest has to be holding the variant it was published for. Two variants of one
 * run are different bytes, so a filename that did not distinguish them would produce a mismatch that
 * reads as tampering. The complete file keeps the name it has always had, so a runbook that downloads
 * it and checks the name still works.
 */
export function exportName(scan: Scan, extension: 'csv' | 'json', variant: ExportVariant = DEFAULT_VARIANT): string {
  const day = scan.finishedAt.toISOString().slice(0, 10);
  const which = variant === DEFAULT_VARIANT ? '' : `-${variant}`;
  return `well-architected-${day}-${scan.id.slice(0, 8)}${which}.${extension}`;
}
