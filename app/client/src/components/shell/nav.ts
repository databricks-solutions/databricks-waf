// What the app contains, as a structure rather than as a row of links.
//
// Grouped, and the groups are the reader's questions in the order they ask them: what is my
// posture, what should I change, what did you actually look at, what happened. A flat list of five
// labels makes "Findings" and "Checks" look like siblings of equal weight, which sends people
// to the wrong one — one is the result, the other is the method.
//
// Optimisation is second because it is the only group that is not about the framework at all. It is
// what the estate would do differently, and none of it is scored.
//
// Declared as data because two surfaces render it (the rail and the mobile sheet) and a third
// reads it to title the page. Three copies of a nav list is three chances for a route to exist
// with no way to reach it.

import {
  Activity,
  BadgeCheck,
  Calendar,
  ClipboardCheck,
  Compass,
  Database,
  DatabaseZap,
  FileSearch,
  FileText,
  Gauge,
  Hammer,
  HeartPulse,
  History,
  LayoutDashboard,
  Layers,
  ListChecks,
  Network,
  MessageSquareCheck,
  Power,
  Ruler,
  ScrollText,
  ShieldAlert,
  Target,
  Timer,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Matched exactly, for a route that is a prefix of every other. */
  readonly end?: boolean;
  /**
   * Which run populates this page, where it is not the assessment.
   *
   * Declared here rather than inferred from the path, because the header reads it: the line under the
   * title and the button beside it both have to name the cycle that produced what is on screen, and a
   * list of advisory paths kept in the header would be a second copy of this structure that a new page
   * could be added without.
   *
   * `live` is the third answer and it is "none of them": the page ran its own statements when it
   * opened. It is here because the header's default is to describe the assessment, and a page read
   * live carrying "Measured 09:12 · 30-day lookback · catalogue 1.4.0" states four true facts about
   * something the reader is not looking at — which is the failure that put `advisory` here.
   */
  readonly source?: 'advisory' | 'live';
  /** One line, shown in the mobile sheet where there is room to explain. */
  readonly hint: string;
}

export interface NavGroup {
  readonly label: string;
  readonly items: readonly NavItem[];
}

export const NAV: readonly NavGroup[] = [
  {
    label: 'Assessment',
    items: [
      {
        to: '/overview',
        label: 'Dashboard',
        icon: LayoutDashboard,
        end: true,
        hint: 'Posture, coverage and the most important change across the estate',
      },
      /*
       * After Overview rather than under Method, because this is the completion of a run, not a
       * description of how the number was arrived at. The Answers page is how a person states a
       * practice; this page is how they record that a pillar of this run still stands, or that they
       * skipped it. Filing it with Answers would present a confirm as another questionnaire.
       *
       * After Overview rather than after Findings because a completed run is routed here before the
       * result is the thing a reader should act on — seven summaries, then a confirm or a skip.
       */
      {
        to: '/review',
        label: 'Review',
        icon: BadgeCheck,
        hint: 'What a completed run still needs a person to confirm or skip, pillar by pillar',
      },
      {
        to: '/pillars',
        label: 'Pillars',
        icon: Layers,
        hint: 'One pillar at a time, with its requirements and its worst results',
      },
      {
        to: '/findings',
        label: 'Findings',
        icon: FileSearch,
        hint: 'Every requirement and its outcome, with the evidence behind it',
      },
      /*
       * After Findings, not between Overview and Review: Review stays the completion of a run.
       * Live, and not scored — the seven statements name pairs; they do not move a pillar.
       */
      {
        to: '/topology',
        label: 'Estate',
        icon: Network,
        source: 'live',
        hint: 'The jobs, tables, warehouses, pipelines and clusters the seven statements joined',
      },
    ],
  },
  /*
   * The alternative the serverless entry named, taken.
   *
   * That entry sat under Assessment with a comment saying a group of its own for one page was the
   * option not worth building. It is two pages now, and both answer a question the Assessment group
   * does not: not "is this estate well run" but "what should I change on Monday". Neither is scored,
   * which is why leaving them among the pillars misread them — a reader who finds migration advice
   * beside a number reasonably assumes it moves the number.
   *
   * Workloads first, because it is the one that applies to every estate. An estate already fully on
   * serverless has nothing to read on the second page and still has queries to fix.
   *
   * Warehouses second, and the order between the first two is the order the advice is acted on rather
   * than a preference. A query and the warehouse it ran on are usually owned by different people, and the
   * warehouse page is the one whose advice is a configuration change somebody can make this afternoon —
   * but a warehouse resized to accommodate a query that should not be running the way it is has been
   * sized to the wrong workload.
   *
   * Jobs third, above serverless and below the two query pages, because it is about the same jobs the
   * serverless page is and answers the earlier question: how a job's runs went at all, before whether its
   * compute could move. A job whose runs mostly do not succeed is not a job to migrate.
   */
  {
    label: 'Optimisation',
    items: [
      {
        to: '/workloads',
        label: 'Workloads',
        icon: Gauge,
        source: 'advisory',
        hint: 'Which queries cost the most, what is wrong with each, and whether it is getting worse',
      },
      {
        to: '/warehouses',
        label: 'Warehouses',
        icon: Power,
        source: 'advisory',
        hint: 'Whether each SQL warehouse is the right size for what it was asked to do, and what it was billed for',
      },
      {
        to: '/jobs',
        label: 'Jobs',
        icon: Timer,
        source: 'advisory',
        hint: 'How each job’s runs went — how they ended, how long they took, and where their time went',
      },
      /*
       * Fourth, after the three pages about compute and before serverless, because it is the first page in
       * the group whose subject is the data rather than the machine — and the last one whose remedy the
       * reader owns. A rewrite that should be a merge is a change to a pipeline somebody wrote; moving a
       * job to serverless is a change to how it runs.
       *
       * Below jobs rather than beside workloads, though both are read off the query history, because the
       * order in this group is the order the advice is acted on: a statement that is slow, a warehouse that
       * is the wrong size and a job that fails are all this week's work, and how the estate writes is a
       * quarter's.
       */
      {
        to: '/writes',
        label: 'Writes',
        icon: DatabaseZap,
        source: 'advisory',
        hint: 'How the estate writes — what rewrites its target over and over, and what loads it in small pieces',
      },
      {
        to: '/serverless',
        label: 'Serverless',
        icon: Zap,
        source: 'advisory',
        hint: 'Which jobs could move to serverless compute, what stops the rest, and what it would cost',
      },
      /*
       * Last in the group, and the only page in it that is about the data rather than about the
       * compute. It is here rather than under Assessment because nothing on it is scored and none of
       * it is a requirement: it reads the relations somebody declared this organisation serves and
       * says how far each is from being usable by a person who did not build it.
       *
       * Last because it is the one whose remedy is other people's work. A warehouse can be resized
       * this afternoon; a thousand tables acquire descriptions and owners over quarters, and putting
       * that first would open the group with the item nobody can finish.
       */
      {
        to: '/foundation',
        label: 'Serving data',
        icon: Database,
        source: 'live',
        hint: 'How ready the data this organisation says it serves is to be found, trusted and understood',
      },
    ],
  },
  {
    label: 'Method',
    items: [
      /*
       * First in the group, above the definitions, because it is the only page here that is not about
       * this customer at all.
       *
       * The group's order is the order of the argument, and this is its first premise: this is the
       * framework and how it weighs, this is what you scoped from it, this is what ran against that,
       * this is what a person asserted where nothing could run. Filing it after the definitions would
       * put "what did you decide to assess" above "what is there to assess", which is the wrong way
       * round for a reader who has just been handed a score and wants to know what it is out of.
       *
       * It is also the only page in this group nobody can change, which is the point of it. See
       * ADR 0059.
       */
      {
        to: '/methodology',
        label: 'Methodology',
        icon: Ruler,
        hint: 'What the app measures against, how heavily each requirement weighs, and what each release changed',
      },
      /*
       * The only page in this group that is written to rather than read.
       *
       * Under Method because a reader's question on this rail is how the number was arrived at, and
       * the first part of that answer is what the number is of. It sits above Checks because the
       * order is the order of the argument: this is what was assessed, this is what was executed
       * against it, this is what a person asserted where nothing could be executed.
       */
      {
        to: '/definitions',
        label: 'Definitions',
        icon: Target,
        hint: 'What each assessment covers, who owns it, and what changed between its versions',
      },
      {
        to: '/checks',
        label: 'Checks',
        icon: ListChecks,
        hint: 'What a scan executes, what it reads, and what permission that needs',
      },
      /*
       * Under Method rather than under Assessment, which is the only place it could honestly go.
       *
       * These answers do move the score, so there is a case for grouping them with the results.
       * But the group a reader learns from this rail is "how the number was arrived at", and an
       * answered requirement was arrived at by asking somebody. Filing it beside the measured
       * findings would present the two as the same kind of claim in the one place the app has to
       * keep them apart.
       */
      {
        to: '/answers',
        label: 'Answers',
        icon: MessageSquareCheck,
        hint: 'Requirements no scan can reach, answered by a person and due for review',
      },
    ],
  },
  {
    label: 'Record',
    items: [
      /*
       * Under Record and not under Assessment, on the same reasoning as the report.
       *
       * A decision is not a seventh view of the results. It is what somebody undertook to do about
       * them, dated and attributed, and it is read later by whoever inherits the estate — usually
       * to find out why a failure has been sitting there for four months. Filing it with the
       * findings would suggest it changes them. It does not: the requirement still fails and still
       * costs its points, and the whole feature depends on that staying legible.
       */
      {
        to: '/decisions',
        label: 'Decisions',
        icon: ClipboardCheck,
        hint: 'What was accepted, planned or claimed fixed, and whether the estate agrees',
      },
      /*
       * Beside the decisions rather than under Assessment, and the pair is the point.
       *
       * A decision is what somebody undertook about a risk — accept it, park it, claim it fixed. A plan
       * is a commitment to change something, with an owner and a date and a definition of done. Both
       * are records of intent rather than of measurement, which is why they are in this group, and
       * they are two entries rather than one because the app must never let a plan be read as a
       * decision: raising an action does not park a finding, and closing one does not make a
       * requirement pass.
       */
      /*
       * Its own entry rather than a filter on the decisions register, and the separation is the record's
       * whole argument.
       *
       * A decision says what somebody undertook. An exception says what is holding the line while a
       * requirement is unmet, and it expires — which is the question an auditor asks by name and the one
       * a decision cannot answer, because a review date is not an expiry. Folding these rows into the
       * decisions list would file them under the word that made them invisible.
       */
      {
        to: '/exceptions',
        label: 'Exceptions',
        icon: ShieldAlert,
        hint: 'What is accepted as unmet, what holds the line instead, and when each acceptance runs out',
      },
      {
        to: '/improvements',
        label: 'Improvements',
        icon: Hammer,
        hint: 'What is being done about the findings, by whom, and whether a run agrees it is done',
      },
      {
        to: '/history',
        label: 'Runs',
        icon: History,
        hint: 'Every run: who it ran as, what it measured, and what it changed',
      },
      /*
       * Filed under Record rather than under Assessment, because it is not a seventh view of the
       * results — it is the results as an artefact, dated and attributed, for somebody who will
       * never open this app. That is the same thing the run history is for.
       */
      {
        to: '/report',
        label: 'Report',
        icon: FileText,
        hint: 'The whole review as one document, to print or send on',
      },
      /*
       * Beside the report rather than under Assessment, and for the same reason: a published month is
       * an artefact, dated and attributed, for somebody who will not open this app next month. The
       * live preview is a view over runs and decisions; publishing freezes it. Filing it with the
       * findings would suggest the figures still move.
       */
      {
        to: '/months',
        label: 'Months',
        icon: Calendar,
        hint: 'Each month of the cadence, previewed while it is open and frozen once published',
      },
    ],
  },
];

/*
 * The welcome, outside the three groups and below them on the rail.
 *
 * It is not a fourth question about the estate, which is what the groups are: it is what the app is,
 * and it is the only page here that is about the app rather than about the review. In a group it
 * would read as a section of the assessment, and at the top of the first group it would push the
 * overview down for the sake of a page most readers see once.
 *
 * Kept in this file rather than written into the rail, so it obeys the same rule the rest do — a
 * route with no way to reach it is what a declared nav exists to prevent, and the header reads this
 * list to title the page.
 */
export const START: NavItem = {
  to: '/start',
  label: 'Start here',
  icon: Compass,
  end: true,
  hint: 'What this app does, what it does not do, and the words it uses',
};

/*
 * Beside the welcome rather than in a group, for the same reason it is: this is about the app and not
 * about the review. It is the only page here whose subject is the tool's own footing, and in a group
 * of estate pages it would read as a fifth thing that was assessed.
 *
 * At the foot rather than at the top, because most readers should never need it. The pages that do
 * need it link here by name when they hit the fault it explains — an unmeasured pillar, a history that
 * will not load — which is the route a reader actually arrives by.
 */
export const DIAGNOSTICS: NavItem = {
  to: '/diagnostics',
  label: 'Diagnostics',
  icon: HeartPulse,
  end: true,
  hint: 'Whether the warehouse, the database and the identity endpoint are answering, and what to do',
};

/*
 * Beside the diagnostics for the same reason: this is about the app rather than about the review.
 *
 * It is the answer to the first question an enterprise privacy review asks — how long do you keep
 * this — and it is also the only page in the app from which anything is deliberately removed. Filed
 * with the estate pages it would read as a sixth thing that was assessed; at the foot it is where
 * somebody goes deliberately, which is the right way to reach a page with a delete button on it.
 */
export const RETENTION: NavItem = {
  to: '/retention',
  label: 'Retention',
  icon: Timer,
  end: true,
  hint: 'How long records are kept, what a legal hold is preserving, and removing what is past its period',
};

/*
 * At the foot with the other two, and for a reason worth stating: the reader this page exists for is
 * not the reader the rest of the app was built for.
 *
 * Every estate page answers "how well is this platform run". This one answers "what has been done to
 * this app, by whom", which is an auditor's question rather than an assessor's. Putting it in a group
 * of pillars would file the record of the tool among the findings of the review.
 */
export const TRAIL: NavItem = {
  to: '/trail',
  label: 'Audit trail',
  icon: ScrollText,
  end: true,
  hint: 'Every event this app recorded, who asked, and how it ended',
};

/** The composed return point for recurring assessment operations. */
export const OPERATE: NavItem = {
  to: '/operate',
  label: 'Next actions',
  icon: Calendar,
  end: true,
  hint: 'Open reviews, the latest report and improvement plans for this assessment',
};

/**
 * The four customer tasks approved for the application shell.
 *
 * The existing routes stay addressable while the later 107/110 rows compose each task into one
 * surface. Grouping them here prevents that transition from putting the old record-type directory
 * back into persistent navigation.
 */
export interface PrimaryTask {
  readonly label: 'Assess' | 'Investigate' | 'Improve' | 'Operate';
  readonly to: string;
  readonly icon: LucideIcon;
  readonly hint: string;
  readonly items: readonly NavItem[];
}

const byRoute = new Map(NAV.flatMap((group) => group.items).map((item) => [item.to, item] as const));

function route(to: string): NavItem {
  const item = byRoute.get(to);
  if (item == null) throw new Error(`Navigation route ${to} is not declared`);
  return item;
}

const PREPARE: NavItem = { ...route('/definitions'), to: '/definitions/setup', label: 'Prepare assessment' };

export const INVESTIGATE: NavItem = {
  to: '/investigate',
  label: 'Investigation workbench',
  icon: Network,
  hint: 'Pillars, evidence, findings, change and recommended actions in one workspace',
};

export const PRIMARY_TASKS: readonly PrimaryTask[] = [
  {
    label: 'Assess',
    to: '/review',
    icon: BadgeCheck,
    hint: 'Prepare, collect, review and publish one assessment',
    items: [route('/review'), PREPARE, route('/answers')],
  },
  {
    label: 'Investigate',
    to: '/investigate',
    icon: Network,
    hint: 'Connect pillars, findings, estate evidence and change',
    items: [INVESTIGATE],
  },
  {
    label: 'Improve',
    to: '/improvements',
    icon: Hammer,
    hint: 'Prioritise opportunities and move actions through validation',
    items: [
      route('/improvements'),
      route('/workloads'),
      route('/warehouses'),
      route('/jobs'),
      route('/writes'),
      route('/serverless'),
      route('/foundation'),
      route('/decisions'),
      route('/exceptions'),
    ],
  },
  {
    label: 'Operate',
    to: '/operate',
    icon: Calendar,
    hint: 'Return to open work, run history and the monthly cycle',
    items: [OPERATE, route('/review'), route('/history'), route('/months')],
  },
];

/** Secondary pages that explain or administer the product rather than perform a customer task. */
export const UTILITIES: readonly NavItem[] = [
  route('/methodology'),
  route('/definitions'),
  route('/checks'),
  START,
  DIAGNOSTICS,
  TRAIL,
  RETENTION,
];

const IMPROVE_PATHS = new Set(PRIMARY_TASKS[2]?.items.map((item) => item.to));
const OPERATE_PATHS = new Set(['/operate', '/history', '/months']);
const INVESTIGATE_PATHS = new Set(['/investigate', '/pillars', '/findings', '/topology', '/report']);

const CUSTOMER_PREVIEW_PATHS: ReadonlyMap<string, string> = new Map([
  ['dashboard', '/overview'],
  ['assess', '/review'],
  ['investigate', '/investigate'],
  ['improvement', '/improvements'],
  ['operate', '/operate'],
  ['report', '/report'],
] as const);

/** The production route whose exact composition a deterministic customer preview renders. */
export function canonicalCustomerPath(pathname: string): string {
  const match = /^\/preview\/([^/]+)(?:\/|$)/.exec(pathname);
  return match == null ? pathname : (CUSTOMER_PREVIEW_PATHS.get(match[1] ?? '') ?? pathname);
}

export function isCustomerPreview(pathname: string): boolean {
  return canonicalCustomerPath(pathname) !== pathname;
}

function belongsTo(pathname: string, paths: ReadonlySet<string>): boolean {
  return [...paths].some((path) =>
    path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(`${path}/`)
  );
}

/** The customer task that owns a route. Utility pages deliberately have no task selected. */
export function taskFor(pathname: string): PrimaryTask | undefined {
  pathname = canonicalCustomerPath(pathname);
  // The summary is orientation across all four tasks, not an Investigate view and not a fifth task.
  // Keeping it outside task ownership also prevents the command bar from spending scarce width on
  // a contextual menu that merely repeats links already available under Investigate.
  if (pathname === '/' || pathname === '/overview') return undefined;
  if (pathname === '/definitions/setup') return PRIMARY_TASKS[0];
  if (UTILITIES.some((item) => pathname === item.to || pathname.startsWith(`${item.to}/`))) return undefined;
  if (belongsTo(pathname, IMPROVE_PATHS)) return PRIMARY_TASKS[2];
  if (belongsTo(pathname, OPERATE_PATHS)) return PRIMARY_TASKS[3];
  if (belongsTo(pathname, INVESTIGATE_PATHS)) return PRIMARY_TASKS[1];
  return PRIMARY_TASKS[0];
}

/** The item a path belongs to, for the page header's own title and breadcrumb. */
export function itemFor(pathname: string): NavItem | undefined {
  pathname = canonicalCustomerPath(pathname);
  const items = [
    ...NAV.flatMap((group) => group.items),
    PREPARE,
    INVESTIGATE,
    START,
    OPERATE,
    DIAGNOSTICS,
    RETENTION,
    TRAIL,
  ];
  // Longest match first, so /history/:id resolves to Runs rather than to the root.
  return [...items]
    .sort((a, b) => b.to.length - a.to.length)
    .find((item) =>
      item.end === true ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`)
    );
}

/** The icon for the scan-state indicator, kept beside the nav icons so one file owns the set. */
export const SCAN_ICON = Activity;
