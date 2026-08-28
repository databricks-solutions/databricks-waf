// The improvement plan as a file somebody can send, rather than a page somebody needs an account to see.
//
// The assessment export answers "what is wrong". This answers the question an executive asks after
// reading it, which is "what are you doing about it" — and that turned out to be a document rather
// than a section, for two reasons that are worth keeping.
//
// The first is who reads it. The report at `/report` is what somebody sends upwards once; the plan is
// what gets asked about at every review afterwards, by a different person, usually with the previous
// version in front of them. Folding the plan into the assessment export would make the wrong reader's
// spreadsheet thirty rows longer while still leaving the plan unsendable on its own.
//
// The second is how often each one moves. An assessment export is a function of a run and the
// decisions standing against it, and a run is finished. A plan moves whenever an owner moves an
// action, which is daily. "The same assessment produces the same document" is a sentence worth
// keeping short, and a plan folded into it would have needed a much longer footnote.
//
// # What is reproducible here, and what is not
//
// The same rules as `artefact.ts`: the bytes are a function of the record, never of the request. So two
// exports of a plan in the same state are the same bytes and the same digest, which is the only thing
// that makes a published digest worth reading out.
//
// That rule cost this file a column, and the loss is the interesting part. An action's `lateness` — the
// `on-time` / `due` / `overdue` reading the board shows — is a comparison between a due date and *now*,
// so a document carrying it changes at midnight on an unchanged plan. The panel would then tell a sender
// their recipient's copy "no longer matches because the record has moved", when nothing had moved but
// the date. That is the exact false alarm publishing digests exists to prevent.
//
// The obvious repair is to pin the comparison to the run the file is judged against, since every other
// judged column already reads as at that run. It is wrong, and worse than the disease: on an install
// whose last scan was three weeks ago, an action that went overdue a fortnight back would export as
// `on-time` in the same row as the `due` date that disproves it. A document that contradicts itself is
// worse than one that leaves a reader to subtract two dates.
//
// So lateness is not here, and neither is the `overdue` rollup derived from it. What is here is `due`,
// in every variant, and `judged_at` — from which a reader gets a correct answer relative to the day they
// are reading rather than a stale one baked in on the day it was sent. This is the same judgement
// ADR 0050 made when `generatedAt` was removed in the assessment document's version 2: a fact about the
// moment of download has no place in a file whose digest is published. A derived one is worse, because
// a reader quotes it.
//
// A plan's state includes what the estate currently says about the requirements its actions name —
// `agreement` is a comparison between a claim and a run — so a plan's digest changes when a new run
// lands, as well as when somebody moves an action. That is the same honest mismatch a decision
// creates for an assessment export, and it is handled the same way: the file names the run it was
// judged against, so a recipient reading a different agreement from a later download can see why
// rather than reporting tampering.
//
// # Notes are not here
//
// Deliberately, and by decision rather than oversight: notes are internal-only (ADR 0052) and a plan
// document is a thing somebody sends outside. The same reasoning keeps them out of every other
// export.
//
// # Variants
//
// Three rather than the assessment's four, and not the same three words, because the readers are not
// the same readers — there is no provenance of a reading to carry in a plan, so `technical` would be a
// file identical to another one under a second name. What is here instead is the sponsor, whoever is
// running the work, and whoever is establishing later that the work happened.
//
// The one rule from `variant.ts` that carries over unchanged is the important one: **a variant chooses
// columns, never rows.** Every variant carries every action in the plan, including the cancelled ones
// and the drafts. A plan document that omitted its cancelled actions could not be told apart from one
// whose author found them inconvenient, and the reader has no way to know which they hold.

import type { Transition } from '../improve/action.js';
import type { ImprovementPlan } from '../improve/plan.js';
import type { ActionProgress, Agreement, PlanProgress } from '../improve/progress.js';
import { csv } from './csv.js';

/**
 * The version of the file format, not of the app.
 *
 * Bump it when a field is removed or its meaning changes; adding one is not a break. Starting at 1
 * rather than at the assessment document's 3: this is a different document with its own history, and
 * sharing a counter would make a reader think version 2 of one said something about the other.
 */
export const PLAN_DOCUMENT_VERSION = 1;

export const PLAN_DOCUMENT_KIND = 'databricks-waf-improvement-plan';

/**
 * The three, in the order a reader meets them.
 *
 * `delivery` rather than `technical`, which is the assessment's word for its complete file: there is
 * nothing technical about a plan, and the person who wants every column is the one running the work.
 */
export const PLAN_VARIANTS = ['executive', 'delivery', 'audit'] as const;

export type PlanVariant = (typeof PLAN_VARIANTS)[number];

/** What a request with no variant gets: the complete file, so a caller is never handed a subset unasked. */
export const DEFAULT_PLAN_VARIANT: PlanVariant = 'delivery';

/**
 * Every column any variant can carry, in the order a row is written.
 *
 * The plan's own columns repeat on every row, like the run's do in an assessment export and for the
 * same reason: a spreadsheet has no header block, and a reader who has filtered to the four actions
 * one owner holds has to still be looking at four complete statements.
 *
 * `PLAN_IDENTITY` has to stay a genuine prefix of this list, which is why `plan_state` sits third
 * rather than after the two it reads best beside. Every variant filters this order and none reorders
 * it, so the executive and delivery files of one plan differ only in which columns are present —
 * somebody diffing the two sees the real difference rather than a shuffle. `variant.ts` holds the
 * assessment export to the same rule and for the same reason.
 */
export const PLAN_COLUMNS = [
  'plan',
  /** Which of the three this file is, so a subset cannot be read as the whole. */
  'plan_variant',
  'plan_title',
  'plan_state',
  'plan_outcome',
  'plan_owners',
  /** The run the plan was raised from. The baseline, as a reference rather than a copy of a score. */
  'baseline_run',
  /** The assessment definition and version the plan was written against, where it cites one. */
  'assessment',
  /**
   * The run every `agreement` in this file was judged against, and when it finished.
   *
   * Without these two the agreement column is unattributable: "contradicted" is a statement about a
   * particular measurement, and a reader comparing two exports needs to know whether the plan moved
   * or the estate did.
   */
  'judged_against',
  'judged_at',
  'action',
  'requirements',
  'requirement_titles',
  'action_outcome',
  'definition_of_done',
  'owner',
  'priority',
  'effort',
  'due',
  'state',
  'agreement',
  'agreement_means',
  /** Which requirements the run still finds unmet. The column behind a contradiction. */
  'unmet',
  /** Which it could not read, which is not agreement and must not be read as it. */
  'unreadable',
  'depends_on',
  'steps',
  /** The run this action was raised from, so the evidence behind it can still be found. */
  'raised_from',
  'created_by',
  'created_at',
  /** Every state the action has been in, oldest first. Audit only — see `PLAN_VARIANT_SHAPES`. */
  'history',
] as const;

export type PlanColumn = (typeof PLAN_COLUMNS)[number];

export interface PlanVariantShape {
  /** Who it is for, in one sentence, written into the file. */
  readonly says: string;
  /** What it leaves out and where the whole of it is, or absent for the complete file. */
  readonly omits?: string;
  readonly columns: readonly PlanColumn[];
  /**
   * Whether each action carries every state it has been in, with who moved it and why.
   *
   * The audit file alone. It is the block that establishes a claim was made before a run agreed with
   * it rather than after — which is the whole of AUD-DEC-107 — and it is also the one field that is
   * many values per action, so in a spreadsheet it is a cell somebody has to widen. In a plan a
   * sponsor is reading, that cell is what makes them stop reading.
   */
  readonly history: boolean;
}

/** The columns every variant carries: which plan, which file, which action, what state it is in. */
const PLAN_IDENTITY: readonly PlanColumn[] = ['plan', 'plan_variant', 'plan_title', 'plan_state'];

/**
 * What each variant is.
 *
 * Written out rather than composed from differences, for the reason `variant.ts` gives: a review of
 * this file should answer "what does an auditor get that a delivery lead does not" by reading two
 * lists rather than resolving three spreads.
 */
export const PLAN_VARIANT_SHAPES: Readonly<Record<PlanVariant, PlanVariantShape>> = {
  executive: {
    says:
      'For the reader who asked what is being done about the assessment: what the plan is for, who is ' +
      'answerable for it, and for every action the outcome it buys, who owns it, when it is expected and ' +
      'whether the estate agrees it happened.',
    omits:
      'It carries every action and not every column: the steps, the dependencies between actions, the effort ' +
      'estimate, who raised each action and from which run, and the history of who moved what are in the ' +
      'delivery and audit exports of the same plan.',
    columns: [
      ...PLAN_IDENTITY,
      'plan_outcome',
      'plan_owners',
      'judged_against',
      'judged_at',
      'action',
      'requirements',
      'requirement_titles',
      'action_outcome',
      // Kept, and the one column a sponsor's file must not drop. It is the answer to the question
      // that gets asked at the next review — how will we know this is finished — and it is one
      // sentence, so the argument for leaving it out is only that it is long.
      'definition_of_done',
      'owner',
      'priority',
      'due',
      'state',
      'agreement',
      'agreement_means',
      // Named rather than counted, for the reason `ActionProgress` names them: "2 of 5 still failing"
      // sends the reader looking for which two, and a sponsor is exactly the reader who will ask.
      'unmet',
      // Here because this variant carries `agreement`, and one of that column's five values is
      // `unmeasured` — "nothing is failing, and at least one requirement could not be read". A file
      // that says that and does not say which requirement has told a sponsor there is a hole in the
      // measurement and left them no way to ask about it. One short cell, empty on most rows.
      'unreadable',
    ],
    history: false,
  },

  delivery: {
    says:
      'The complete file for whoever is running the work: every action, what would have to be true for it ' +
      'to be finished, the steps, what it waits on, and what the last run made of the claim.',
    columns: [...PLAN_COLUMNS].filter((column) => column !== 'history'),
    history: false,
  },

  audit: {
    says:
      'For a reader establishing later that the work happened: everything the delivery file carries, plus ' +
      'every state each action has been in, who moved it, when, and why — which is what shows a claim was ' +
      'made before a run agreed with it rather than after.',
    columns: [...PLAN_COLUMNS],
    history: true,
  },
};

/**
 * The variant a request asked for, or nothing when it named something this app does not produce.
 *
 * Refused rather than defaulted, exactly as `variantOf` refuses for an assessment: a caller who asks
 * for `?variant=summary` and is handed the complete file has been given a document they will describe
 * to somebody else as a summary, and the mistake surfaces in the meeting where the two do not match.
 */
export function planVariantOf(asked: unknown): PlanVariant | undefined {
  if (asked == null || asked === '') return DEFAULT_PLAN_VARIANT;
  return PLAN_VARIANTS.find((variant) => variant === asked);
}

/**
 * What each agreement means, spelled out.
 *
 * The same judgement `document.ts` makes about its decision words: `contradicted` is the reason these
 * columns are in the file at all, and a spreadsheet cell reading "contradicted" beside an action
 * somebody reported finished would need explaining to whoever reads the sheet next.
 */
const AGREEMENT: Readonly<Record<Agreement, string>> = {
  unclaimed: 'nobody has said this is done yet',
  awaiting: 'reported done, no run has measured it since',
  agreed: 'a run measured every requirement as met after it was reported done',
  contradicted: 'reported done, and a later run still finds a requirement unmet',
  unmeasured: 'reported done, nothing is failing, and at least one requirement could not be read',
  unjudged: 'raised from advisor advice, so no requirement in the framework can agree or disagree with it',
};

/**
 * The same column for an action no requirement can answer, and the reason there are two maps.
 *
 * Every sentence above names a run and a requirement. An action raised from advisor advice has
 * neither: it is settled by a later advisory no longer reporting one rule on one resource, which is
 * `advice-settle.ts`. Exporting the assessment's wording against it would put "a run measured every
 * requirement as met" in a spreadsheet cell beside an action that names no requirement and that no run
 * read — the sentence saying more than the field, in the one artefact a reader keeps.
 *
 * `unclaimed` and `unjudged` are the same under either judge and are still written out: the exhaustive
 * record is what makes a new agreement state fail this file rather than silently take the other map's
 * word for it.
 */
const ADVISED_AGREEMENT: Readonly<Record<Agreement, string>> = {
  unclaimed: 'nobody has said this is done yet',
  awaiting: 'reported done, no advisory has read the estate since',
  agreed: 'an advisory after it was reported done read the resource and did not report the rule it came from',
  contradicted: 'reported done, and a later advisory still reports the same rule on the same resource',
  unmeasured:
    'reported done, and the latest advisory could not speak to it — it did not report the resource, ' +
    'formed no analysis, or this build no longer carries the rule',
  unjudged: 'raised from advisor advice, so no requirement in the framework can agree or disagree with it',
};

/**
 * Which of the two an action's row is written in: the requirements it names, and nothing else.
 *
 * The same discriminator `progress.ts` computes the agreement with and the client words the pane with.
 * An action carrying advice *and* a requirement is the assessment's, so it gets the assessment's
 * sentence here too.
 */
function agreementMeans(reading: ActionProgress): string {
  return reading.action.controlIds.length === 0
    ? ADVISED_AGREEMENT[reading.agreement]
    : AGREEMENT[reading.agreement];
}

export interface PlanExportOptions {
  readonly plan: ImprovementPlan;
  /**
   * Every action in the plan, each with what the run made of it.
   *
   * Passed in already judged, like an assessment's decisions are: an agreement is a comparison
   * between a claim and one particular run, so the caller establishes which run and this file names
   * it. Ordering is the caller's — the routes send newest first, which is what the plan's own page
   * shows, and a file that reordered them would be a second opinion about what the plan looks like.
   */
  readonly actions: readonly ActionProgress[];
  readonly progress: PlanProgress;
  /** The requirement's title, so a row can be read without the app. Absent for one a later catalogue dropped. */
  readonly titleOf: (controlId: string) => string | undefined;
  /**
   * The run the agreements were judged against, and when it finished.
   *
   * Absent on an install that has never run a scan, which is a real case rather than a defect: a plan
   * can be written from a workshop. Every agreement in that file reads `unclaimed` or `awaiting`, and
   * a reader who can see there was no run to judge against knows why.
   */
  readonly judgedAgainst?: { readonly runId: string; readonly at: Date };
  readonly variant?: PlanVariant;
}

/**
 * The plan as structured data, for a reader who is going to diff two of them or feed a tracker.
 *
 * No `generatedAt`, and that absence is the point rather than an omission — it is the field that made
 * assessment exports unverifiable until version 2 removed it, and repeating the mistake in a second
 * document would be repeating it knowingly. ADR 0050.
 */
export function planDocument(options: PlanExportOptions): Record<string, unknown> {
  const { plan, progress } = options;
  const variant = options.variant ?? DEFAULT_PLAN_VARIANT;
  const shape = PLAN_VARIANT_SHAPES[variant];

  return {
    document: PLAN_DOCUMENT_KIND,
    documentVersion: PLAN_DOCUMENT_VERSION,
    /*
     * The sentence travels with the identifier for the reason the assessment document gives: the
     * reader who needs it is holding the file with no access to this app, and `variant: "executive"`
     * alone is a word they would have to ask somebody about.
     */
    variant,
    variantMeans: shape.says,
    ...(shape.omits != null ? { variantOmits: shape.omits } : {}),
    plan: {
      id: plan.id,
      title: plan.title,
      outcome: plan.outcome,
      owners: plan.owners,
      state: plan.closed != null ? 'closed' : 'open',
      /*
       * Which version of the plan this file describes.
       *
       * Here because it is the cheapest way for somebody holding two exports to tell which is later,
       * and because a digest that changed with no revision change is the signal that the estate moved
       * rather than the plan.
       */
      revision: plan.revision,
      createdBy: plan.createdBy,
      createdAt: plan.createdAt.toISOString(),
      ...(plan.raisedFrom != null ? { baselineRun: plan.raisedFrom } : {}),
      ...(plan.assessment != null ? { assessment: plan.assessment } : {}),
      ...(plan.closed != null
        ? {
            closed: {
              at: plan.closed.at.toISOString(),
              by: plan.closed.by,
              reason: plan.closed.reason,
            },
          }
        : {}),
    },
    /*
     * The rollup, which is counts and named lists and never a percentage.
     *
     * `progress.ts` refuses a single figure over a plan and this file does not add one back: five
     * actions of which three are verified is not 60% of an outcome, and a number in a file is the one
     * that ends up in a slide with nothing underneath it.
     */
    progress: {
      states: progress.states,
      contradicted: progress.contradicted,
      // `progress.overdue` is deliberately not here. It is the ids of the actions whose due date has
      // passed *as at the moment of asking*, so a file carrying it would change at midnight on a plan
      // nobody had touched. `nextDue` is the clock-free half of the same question and it stays. See
      // this file's header for the whole argument.
      blocked: progress.blocked,
      settled: progress.settled,
      ...(progress.nextDue != null ? { nextDue: progress.nextDue.toISOString() } : {}),
    },
    ...(options.judgedAgainst != null
      ? { judgedAgainst: { run: options.judgedAgainst.runId, at: options.judgedAgainst.at.toISOString() } }
      : {}),
    actions: options.actions.map((reading) => actionField(reading, options, shape)),
  };
}

function actionField(
  reading: ActionProgress,
  options: PlanExportOptions,
  shape: PlanVariantShape
): Record<string, unknown> {
  const { action } = reading;
  const carries = (column: PlanColumn): boolean => shape.columns.includes(column);

  return {
    id: action.id,
    requirements: action.controlIds.map((id) => {
      const title = options.titleOf(id);
      return title != null ? { id, title } : { id };
    }),
    outcome: action.outcome,
    ...(carries('definition_of_done') ? { definitionOfDone: action.definitionOfDone } : {}),
    owner: action.owner,
    priority: action.priority,
    ...(carries('effort') ? { effort: action.effort } : {}),
    ...(action.due != null ? { due: action.due.toISOString() } : {}),
    state: action.state,
    agreement: reading.agreement,
    agreementMeans: agreementMeans(reading),
    unmet: reading.unmet,
    ...(carries('unreadable') ? { unreadable: reading.unreadable } : {}),
    ...(carries('depends_on') ? { dependsOn: action.dependsOn } : {}),
    ...(carries('steps') ? { steps: action.steps } : {}),
    ...(carries('raised_from') && action.raisedFrom != null ? { raisedFrom: action.raisedFrom } : {}),
    ...(carries('created_by') ? { createdBy: action.createdBy, createdAt: action.createdAt.toISOString() } : {}),
    ...(shape.history
      ? {
          history: action.history.map((entry) => ({
            from: entry.from,
            to: entry.to,
            at: entry.at.toISOString(),
            by: entry.by,
            who: entry.who,
            ...(entry.reason != null ? { reason: entry.reason } : {}),
          })),
        }
      : {}),
  };
}

/** The plan as a spreadsheet: the columns the variant carries, and one row per action. */
export function planCsv(options: PlanExportOptions): string {
  return csv(planRows(options));
}

function planRows(options: PlanExportOptions): readonly (readonly string[])[] {
  const variant = options.variant ?? DEFAULT_PLAN_VARIANT;
  const { columns } = PLAN_VARIANT_SHAPES[variant];
  const header = columns.map((column) => column as string);

  const row = (reading?: ActionProgress): readonly string[] =>
    columns.map((column) => CELL[column]({ options, variant, reading }));

  // A plan with no actions still produces a row, and it is the plan's own columns with the action's
  // left empty. A header with nothing under it reads as a file that failed to build; a row naming the
  // plan and nothing else reads as what it is, which is a plan nobody has written work into yet.
  if (options.actions.length === 0) return [header, row()];

  return [header, ...options.actions.map((reading) => row(reading))];
}

/** What one cell is written from: the plan, and the action whose row it is where there is one. */
interface Cell {
  readonly options: PlanExportOptions;
  readonly variant: PlanVariant;
  /**
   * Absent on the single row a plan with no actions produces.
   *
   * So every column about an action answers empty for that row rather than the caller having to know
   * which columns those are — which is what the previous shape got wrong. See `planRows`.
   */
  readonly reading?: ActionProgress;
}

/**
 * Every column, and what it writes. A record rather than a switch, and that is a correctness matter.
 *
 * `document.ts` keys its cells the same way and the reason is the one that bit here: two switches with
 * `default` clauses type-check against a column list they do not cover, so adding a name to
 * `PLAN_COLUMNS` compiled, shipped, and wrote a blank column into a document whose entire value is that
 * a reader can trust what is in it. A blank column is worse than a missing one — the reader concludes
 * the plan has no owner rather than that the file has no answer. Keyed on `PlanColumn`, the typecheck
 * refuses the new column until somebody says what it holds.
 */
const CELL: Readonly<Record<PlanColumn, (at: Cell) => string>> = {
  plan: ({ options }) => options.plan.id,
  plan_variant: ({ variant }) => variant,
  plan_title: ({ options }) => options.plan.title,
  // Not "open" and "closed" alone: a settled plan whose actions are all terminal is a different state
  // from one nobody has closed yet, and the difference is what a reader chasing outstanding work is
  // filtering for.
  plan_state: ({ options }) =>
    options.plan.closed != null
      ? `closed ${options.plan.closed.at.toISOString().slice(0, 10)}`
      : options.progress.settled
        ? 'open, every action settled'
        : 'open',
  plan_outcome: ({ options }) => options.plan.outcome,
  plan_owners: ({ options }) => options.plan.owners.join(' '),
  baseline_run: ({ options }) => options.plan.raisedFrom ?? '',
  assessment: ({ options }) =>
    options.plan.assessment != null
      ? `${options.plan.assessment.definitionId} v${String(options.plan.assessment.version)}`
      : '',
  judged_against: ({ options }) => options.judgedAgainst?.runId ?? 'no run has measured this estate',
  judged_at: ({ options }) => options.judgedAgainst?.at.toISOString() ?? '',

  action: ({ reading }) => reading?.action.id ?? '',
  requirements: ({ reading }) => reading?.action.controlIds.join(' ') ?? '',
  // Missing titles keep their id rather than becoming a gap, so a row about a requirement a later
  // catalogue dropped still says which one it was. `presentAction` makes the same choice.
  requirement_titles: ({ reading, options }) =>
    reading?.action.controlIds.map((id) => options.titleOf(id) ?? id).join('; ') ?? '',
  action_outcome: ({ reading }) => reading?.action.outcome ?? '',
  definition_of_done: ({ reading }) => reading?.action.definitionOfDone ?? '',
  owner: ({ reading }) => reading?.action.owner ?? '',
  priority: ({ reading }) => reading?.action.priority ?? '',
  effort: ({ reading }) => reading?.action.effort ?? '',
  due: ({ reading }) => reading?.action.due?.toISOString().slice(0, 10) ?? '',
  state: ({ reading }) => reading?.action.state ?? '',
  agreement: ({ reading }) => reading?.agreement ?? '',
  agreement_means: ({ reading }) => (reading != null ? agreementMeans(reading) : ''),
  unmet: ({ reading }) => reading?.unmet.join(' ') ?? '',
  unreadable: ({ reading }) => reading?.unreadable.join(' ') ?? '',
  depends_on: ({ reading }) => reading?.action.dependsOn.join(' ') ?? '',
  // Newline-separated inside one quoted cell, which every spreadsheet renders as lines in the cell. A
  // separator character would be one a step could contain. `csv.ts` defuses each line rather than only
  // the first, which is what makes this safe to paste.
  steps: ({ reading }) => reading?.action.steps.join('\n') ?? '',
  raised_from: ({ reading }) => reading?.action.raisedFrom ?? '',
  created_by: ({ reading }) => reading?.action.createdBy ?? '',
  created_at: ({ reading }) => reading?.action.createdAt.toISOString() ?? '',
  history: ({ reading }) => reading?.action.history.map(transitionLine).join('\n') ?? '',
};

/**
 * One state change, in a form somebody can read down a column.
 *
 * `by` is written as a word rather than left implicit, because the one move a run makes is the one a
 * reader is checking for: an action marked verified by a person would be the lifecycle's central rule
 * broken, and a cell that only named the actor would leave a scan id looking like an unfamiliar
 * colleague. An advisory id reads the same way, and names the other thing that can verify.
 */
function transitionLine(entry: Transition): string {
  const who = AUTHOR[entry.by] == null ? entry.who : `${AUTHOR[entry.by]} ${entry.who}`;
  const reason = entry.reason != null ? ` — ${entry.reason}` : '';
  return `${entry.at.toISOString()} ${entry.from} → ${entry.to} by ${who}${reason}`;
}

/** What to call the id, where the id is a run of something rather than a person. */
const AUTHOR: Readonly<Partial<Record<Transition['by'], string>>> = {
  run: 'run',
  advisor: 'advisory',
};

/**
 * The name it is offered under: the plan and the variant, and deliberately no version.
 *
 * This is where a plan departs from an assessment, and the reason is worth stating because the obvious
 * design is wrong twice.
 *
 * `exportName` puts the run's day and id in the filename, and can, because a finished run is immutable:
 * the name identifies the document. A plan has no equivalent. Its own `revision` does not move when its
 * actions do — only closing it raises that number — so a filename carrying it would be a version that
 * stayed at `r0` across a fortnight of work, which is worse than no version at all.
 *
 * The second reason is the one that settles it. `taken` compares a recorded digest against what a file
 * of the same name would hash to now, and that is how a sender answers a recipient who says the copy
 * they were sent does not match. A name that changed on every download would never recur, so every
 * recorded export would read as a file this build can no longer produce, and the comparison — the whole
 * point of publishing digests for a document that moves — would never fire.
 *
 * So two downloads of one plan share a name and may differ in bytes. Which version the published
 * digests describe is answered by `revision` on the exports payload, where a reader can see it beside
 * the values rather than having to parse a filename.
 */
export function planExportName(
  plan: ImprovementPlan,
  extension: 'csv' | 'json',
  variant: PlanVariant = DEFAULT_PLAN_VARIANT
): string {
  const which = variant === DEFAULT_PLAN_VARIANT ? '' : `-${variant}`;
  return `improvement-plan-${plan.id.slice(0, 8)}${which}.${extension}`;
}
