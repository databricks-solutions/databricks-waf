// Who a file is for, and what that means it carries.
//
// One run, four readers. A board paper wants the verdict and what it would cost to leave it; an
// engineer reconciling the file against the estate wants every reading and who took it; whoever is
// doing the work wants the fix, the page it is on and who agreed to own it; an auditor wants all of
// that plus what produced the run, so the numbers can be reproduced rather than believed. Handing all
// four the same thirty-column file means three of them read past most of it, and the one whose column
// is missing is the auditor — the identity axes a run records were in the store and in no export.
//
// # What a variant may do, and the one thing it may not
//
// A variant chooses **columns and fields**. It does not choose **rows**.
//
// That restraint is the whole design, and it is the existing rule in `document.ts` taken seriously:
// a file that leaves out the requirements that passed, or the ones nobody could measure, cannot be
// told apart from a file that leaves out the requirements somebody found inconvenient. The reader has
// no way to know which they hold. So every variant carries one row per finding, including the passes,
// the not-applicables and the unmeasured — an executive spreadsheet is short because it is fifteen
// columns wide rather than because somebody filtered it, and a reader who sorts it by outcome sees the
// same census the auditor does.
//
// A shorter document for a board still exists, and it is the printed report at `/report`, which is
// prose and a selection and says so. A spreadsheet is not that: it is the artefact people filter,
// pivot and hand to their own management, and a filtered one is a filter applied twice.
//
// # Why the variant is written into the file
//
// Because three of the four are subsets, and a consumer that does not know which it holds will read an
// absent column as an absent fact. `variant` is a field in the JSON and a column on every CSV row —
// repetitive down the column, like the run id beside it, for the reason the module below gives: a
// reader who filtered to twelve rows has to still be looking at twelve complete statements.
//
// The technical variant is named as the complete one in every other variant's own description, so a
// recipient who needs a column this file does not carry knows what to ask for rather than concluding
// the app does not record it.
//
// # Digests
//
// Each variant is its own file with its own digest, and `seal` in `artefact.ts` produces both together
// so a route cannot publish one and serve the other. Two variants of one run are different bytes and
// must be: a recipient checking a digest against the wrong variant would find a mismatch and read it
// as tampering, which is why the filename carries the variant and the trail records the filename.

/**
 * The four, in the order a reader meets them.
 *
 * Executive first because it is the one somebody sends upwards, technical second because it is the
 * complete file and the default, then the two specialist ones.
 */
export const EXPORT_VARIANTS = ['executive', 'technical', 'improvement', 'audit'] as const;

export type ExportVariant = (typeof EXPORT_VARIANTS)[number];

/**
 * What a request with no variant gets.
 *
 * The complete file, so a caller who does not know variants exist is never handed a subset. Every
 * export link this app published before variants did resolves to exactly the same document, which is
 * what stops a deploy changing what an existing runbook downloads.
 */
export const DEFAULT_VARIANT: ExportVariant = 'technical';

/** Every column any variant can carry, in the order a row is written. */
export const EXPORT_COLUMNS = [
  'run',
  /** Which of the four this file is, so a subset cannot be read as the whole. */
  'variant',
  'ran_at',
  'ran_as',
  'ran_with',
  'started_by',
  'methodology_version',
  'methodology_state',
  'methodology_manifest',
  'methodology_effective_date',
  'catalogue_revision',
  /**
   * Where the run stood with its review when the file was written.
   *
   * A fact about the run rather than the requirement, like `run` and `ran_at` beside it, and repeated
   * on every row for the same reason those are: a spreadsheet has nowhere else to put one. After
   * technical catalogue revision, so the executive file — which carries the
   * identity columns and this one — reads its columns in this list's order. Blank on a run this app
   * has no review record for, which is an install that keeps none, not a run nobody reviewed. See
   * `FinalisationPayload`.
   */
  'review',
  /** What produced the run. Audit only: an engineer reads the app version off the page instead. */
  'app_build',
  'scoring_method',
  'pillar',
  'requirement',
  'title',
  'outcome',
  'severity',
  'reason',
  'observed',
  'expected',
  'coverage',
  'evidence',
  'why_unmeasured',
  'next_step',
  'answered_by',
  'answered_at',
  /** When the answer stops counting. Audit only, where the question is whether it still did. */
  'answer_review_by',
  'accountable',
  /** The decision's own id, so a row can be traced to the record. Audit only. */
  'decision_id',
  'decision',
  'decision_standing',
  'decision_reason',
  'decided_by',
  'decided_at',
  'decision_owner',
  'decision_date',
  /**
   * What a customer decided about whether this requirement is scored at all: marked not applicable, or
   * its check disabled — with who owns the decision and why. Distinct from the `decision_*` family
   * above, which is a disposition about a *finding* (accepted, fix planned); this is a decision about
   * the *denominator*. A lapsed one is shown here too, on the requirement it stopped excluding, so a
   * reader reconciling the file against the score can see why a requirement they know was excluded is
   * back in it. Blank where the customer took no such decision. See `apply/apply.ts`.
   */
  'applicability',
  /**
   * The applicability decision's own id, so a row can be traced to the record in the register. Audit
   * only, for the same reason `decision_id` is: it is a join key, not a fact about the estate.
   */
  'applicability_id',
  'applicability_owner',
  'applicability_reason',
  'read_as',
  'collected_at',
  'documentation',
  'where',
] as const;

export type ExportColumn = (typeof EXPORT_COLUMNS)[number];

/**
 * How much of a finding the structured form carries.
 *
 * Three levels rather than a set of flags, because the levels are what the four readers differ on and
 * a flag per field would let a variant be assembled that nobody has a use for. `full` is every field
 * the app records about a finding; `work` is what somebody fixing it needs, which is the observation
 * and the remedy and not the provenance of the reading; `verdict` is the outcome and why, which is
 * what a paper quotes.
 */
export type FindingDetail = 'verdict' | 'work' | 'full';

export interface VariantShape {
  /** Who it is for, in one sentence, written into the file. */
  readonly says: string;
  /**
   * What it leaves out and where the whole of it is, or absent for the complete file.
   *
   * Written into the file beside `says`, because a recipient holding a subset needs to know that is
   * what they hold — and to know the name of the thing to ask for.
   */
  readonly omits?: string;
  readonly columns: readonly ExportColumn[];
  readonly detail: FindingDetail;
  /**
   * Whether the file carries what produced the run: the build, the scoring method, the encoding, the
   * surfaces that answered, and the assessment it was started under.
   *
   * The audit package alone, and not because the others could not carry it. It is the block that lets
   * somebody reproduce a score rather than read one, and it is four digests and a fingerprint — in a
   * board paper it is noise, and noise in the file a board reads is what makes them stop reading it.
   */
  readonly produced: boolean;
}

/** The columns every variant carries: which run, which document, which requirement, what the verdict was. */
const IDENTITY: readonly ExportColumn[] = [
  'run',
  'variant',
  'ran_at',
  'methodology_version',
  'methodology_state',
  'methodology_manifest',
  'methodology_effective_date',
  'catalogue_revision',
];
const VERDICT: readonly ExportColumn[] = ['pillar', 'requirement', 'title', 'outcome', 'severity'];

/**
 * What each variant is.
 *
 * The column lists are written out rather than composed from differences, so a review of this file
 * answers "what does an auditor get that an engineer does not" by reading two lists instead of
 * resolving three spreads.
 */
export const VARIANT_SHAPES: Readonly<Record<ExportVariant, VariantShape>> = {
  executive: {
    says:
      'For a reader who is deciding what to do about the estate rather than working on it: the verdict on ' +
      'every requirement, how much of the estate was looked at, and whether somebody has already taken a ' +
      'decision about it.',
    omits:
      'It carries every requirement and not every column: what was read, who read it and the pages that ' +
      'fix it are in the technical export of the same run.',
    columns: [
      ...IDENTITY,
      // The column this reader needs most and the one they are least likely to ask for. A board paper
      // quoting a score off this file should say whether anybody had been over the half no check can
      // reach, and the reader deciding what to do about the estate is the reader who would otherwise
      // assume somebody had.
      'review',
      ...VERDICT,
      'reason',
      // Kept, and the one column an executive file must not drop. Without it a row reading `pass`
      // says "this is fine" where the truth may be "this is fine in the two hundred tables we
      // sampled out of forty thousand", and the reader forwarding it upwards cannot know.
      'coverage',
      'why_unmeasured',
      'next_step',
      // Kept for the reason `coverage` is: a row reading `not applicable` where a customer decided it,
      // not the estate, is a requirement taken out of the score, and a reader deciding what to do about
      // the estate is owed the difference and who owns it.
      'applicability',
      'applicability_owner',
      'decision',
      'decision_standing',
      'decision_owner',
    ],
    detail: 'verdict',
    produced: false,
  },

  technical: {
    says:
      'The complete file: every requirement, everything read to judge it, whose permissions it was read ' +
      'with, and what has been decided about it.',
    columns: [...EXPORT_COLUMNS].filter(
      // The complete file is every column except the four the audit package adds. Those are about
      // reproducing a run rather than about the estate, and an engineer reconciling findings against
      // their own workspaces has the app open in front of them.
      (column) =>
        column !== 'app_build' &&
        column !== 'scoring_method' &&
        column !== 'answer_review_by' &&
        column !== 'decision_id' &&
        column !== 'applicability_id'
    ),
    detail: 'full',
    produced: false,
  },

  improvement: {
    says:
      'For whoever is doing the work: what each requirement needs, the page it is on, and who has taken ' +
      'it on with what date against it.',
    omits:
      'It carries every requirement and not every column: the provenance of each reading is in the ' +
      'technical export of the same run.',
    columns: [
      ...IDENTITY,
      ...VERDICT,
      // What is wrong, then what to do about it, then the pages to do it on. `observed` is here and
      // `expected` is not: an owner needs to be told 14 of 20 workspaces have no policy, and the
      // sentence saying every workspace should have one is the requirement's title again.
      'observed',
      // Kept for the same reason the executive file keeps it, one step further on: an owner handed
      // "14 of 20 workspaces" from a sampled reading who fixes those fourteen has finished the row
      // and not the requirement.
      'coverage',
      'why_unmeasured',
      'next_step',
      'documentation',
      'where',
      'applicability',
      'applicability_owner',
      'applicability_reason',
      'decision',
      'decision_standing',
      'decision_reason',
      'decision_owner',
      'decision_date',
      'answered_by',
      'accountable',
    ],
    detail: 'work',
    produced: false,
  },

  audit: {
    says:
      'For a reader establishing that the assessment can be relied on: everything the technical file ' +
      'carries, plus what produced the run — the build, the scoring method, the encoding and the ' +
      'surfaces that answered — and the identifier of the two kinds of decision this file carries, the ' +
      'disposition on a finding and the applicability decision on the denominator, and the date every ' +
      'human answer stops counting.',
    columns: [...EXPORT_COLUMNS],
    detail: 'full',
    produced: true,
  },
};

/**
 * The variant a request asked for, or nothing when it named something this app does not produce.
 *
 * Refused rather than defaulted. A caller who asks for `?variant=summary` and is handed the technical
 * file has been given a document they will describe to somebody else as a summary, and the mistake
 * surfaces in the meeting where the two do not match. `undefined` for an absent parameter is the
 * caller not asking, which is the default above.
 */
export function variantOf(asked: unknown): ExportVariant | undefined {
  if (asked == null || asked === '') return DEFAULT_VARIANT;
  return EXPORT_VARIANTS.find((variant) => variant === asked);
}

/**
 * Whether this finding's evidence prose belongs in the file.
 *
 * A `verdict` file carries the reason and not the readings: the reason is this app's sentence about
 * the requirement, and the readings are estate detail — table names, workspace names, counts — which
 * is both what makes the technical file useful and what makes a board paper unreadable.
 */
export function carriesEvidence(detail: FindingDetail): boolean {
  return detail !== 'verdict';
}

/** Whether the file says who took each reading and from where. The complete file and the audit package. */
export function carriesProvenance(detail: FindingDetail): boolean {
  return detail === 'full';
}
