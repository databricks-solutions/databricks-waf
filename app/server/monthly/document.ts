// The bytes a published month is made of, in two formats, built once and never rebuilt.
//
// This is the constraint that makes "frozen" true rather than aspirational (ADR 0072). Storing bytes
// is not enough on its own: if the *page* were re-authored from the catalogue at read time, a
// catalogue upgrade would silently change what a published month says — arriving through the renderer
// while the stored bytes and their digest sat unchanged, so the digest would verify while the document
// lied. That is a worse failure than mutability, because it is invisible.
//
// So the document **denormalises completely**. It carries every string it displays — the month's
// label, the publication's identity, control titles, pillar names, the wording of every delta — and
// the builder resolves nothing. Its input is already-resolved presentational rows: strings, not live
// objects it could look up again later. Nothing here reaches the catalogue, the scan store or the
// decision store, because a build path that can reach them will eventually be made to. The caller that
// assembles the input from live sources is 28b; whatever it changes about how a figure is computed
// changes the *next* month, never a published one.
//
// # No clock, no lookup, one sequence of bytes
//
// The document is a pure function of its input. The publication instant it carries is the one baked
// into the identity at publish, not `new Date()` read here, so building the same publication twice
// produces the same bytes and therefore the same digest — which is the property the whole record type
// rests on. The JSON is canonicalised (RFC 8785) for the reason `verify.ts` needs it: `jsonb` hands
// its keys back in its own order, so a digest over what was stored would not match what is read back
// without a canonical form.

import { canonicalise } from '../records/canonical.js';
import { csv } from '../export/csv.js';
import { monthLabel, type MonthId, type PublicationIdentity } from './publication.js';

/**
 * The version of the document format, not of the app.
 *
 * The first thing anybody does with a machine-readable document is write something that reads it, and
 * the second thing we do is change the shape. A consumer that can check one integer refuses a file it
 * does not understand instead of mapping the wrong field — and once bytes are frozen this matters more
 * than it does for a live export, because no schema change can reach a published month: every future
 * renderer either handles every historical shape or names the one it cannot. Bump on a removal or a
 * meaning change; adding a section is not a break.
 */
export const MONTH_DOCUMENT_VERSION = 1;

export const MONTH_DOCUMENT_KIND = 'databricks-waf-month';

/** A named figure the month reports: a run count, an action tally, an outcome. Both sides are strings. */
export interface Fact {
  readonly label: string;
  readonly value: string;
}

/** A figure that moved over the month, carrying both ends so a reader is not told a delta to trust blind. */
export interface Movement {
  readonly label: string;
  readonly from: string;
  readonly to: string;
}

/** A requirement whose finding changed, denormalised: its own words, its pillar, and the two readings. */
export interface DeltaRow {
  readonly control: string;
  readonly requirement: string;
  readonly pillar: string;
  readonly from: string;
  readonly to: string;
  /** The wording of the delta, when the two readings do not speak for themselves. */
  readonly note?: string;
}

/** A requirement carried as an accepted risk during the month, with who owns it and until when. */
export interface ExceptionRow {
  readonly control: string;
  readonly requirement: string;
  readonly owner: string;
  readonly residual: string;
  readonly until: string;
}

/**
 * One point of the monthly trend, with its comparability against the series base.
 *
 * `comparability` carries the server rule's three outcomes rather than two: a point is drawn even when
 * it cannot be compared, with its reason, because dropping it is how a chart lies by omission — a
 * smooth line across the month the catalogue changed. Moving the client onto the server's rule and
 * choosing the base is 28d; the document only records what that rule decided.
 */
export interface TrendPoint {
  readonly month: MonthId;
  readonly label: string;
  readonly score: string;
  readonly comparability: 'permitted' | 'caveat' | 'refused';
  /** Why a point is caveated or refused, in words. Absent when it compares cleanly. */
  readonly note?: string;
}

/**
 * Everything a month reports, already resolved to the strings it will display.
 *
 * The sections are ADR 0072's: run health, finding deltas, coverage and confidence movement, actions,
 * exceptions, outcomes, and the trend. Each is a list of presentational rows in the order it will be
 * read; the builder does not sort them, so the bytes are a function of what the caller assembled.
 */
export interface MonthContent {
  /**
   * The exact reviewed assessment this month reads from.
   *
   * Absent where no run closes the month or where the review has not produced an immutable result.
   * Kept in the frozen document so a month can prove which result it published instead of asking a
   * later reader to reconstruct that join from dates and ordering.
   */
  readonly assessment?: {
    readonly runId: string;
    readonly reviewId: string;
    readonly finalResultId: string;
    readonly definition?: { readonly id: string; readonly version: number; readonly fingerprint: string };
  };
  readonly runHealth: readonly Fact[];
  readonly findingDeltas: readonly DeltaRow[];
  readonly movement: readonly Movement[];
  readonly actions: readonly Fact[];
  readonly exceptions: readonly ExceptionRow[];
  readonly outcomes: readonly Fact[];
  /**
   * What the review of the run this month reports was made of.
   *
   * Three states. Rows are the review: what was confirmed, what was skipped, and how many answers the
   * confirms cited. Empty is a closing run this app had no review record for — an install that keeps
   * none, or a run finished before reviews were kept, and not a month nobody reviewed. Absent is a
   * month no run closed, where there is nothing for a review to have been of. Publish is held until
   * the review is finished, so rows here report a finished one. `43c`, `GAP-033`.
   */
  readonly review?: readonly Fact[];
  readonly trend: readonly TrendPoint[];
}

/** The publication's identity as it appears in the bytes: dates as ISO strings, nothing to resolve. */
interface DocumentIdentity {
  readonly id: string;
  readonly month: MonthId;
  readonly monthLabel: string;
  readonly publishedAt: string;
  readonly publishedBy: string;
  readonly supersedes?: string;
  readonly reason?: string;
}

/** The whole document, as it is serialised. A plain JSON object so `canonicalise` accepts it. */
export interface MonthDocument {
  readonly documentKind: typeof MONTH_DOCUMENT_KIND;
  readonly documentVersion: typeof MONTH_DOCUMENT_VERSION;
  readonly publication: DocumentIdentity;
  readonly assessment?: MonthContent['assessment'];
  readonly runHealth: readonly Fact[];
  readonly findingDeltas: readonly DeltaRow[];
  readonly movement: readonly Movement[];
  readonly actions: readonly Fact[];
  readonly exceptions: readonly ExceptionRow[];
  readonly outcomes: readonly Fact[];
  readonly review?: readonly Fact[];
  readonly trend: readonly TrendPoint[];
}

/**
 * The document for one publication of one month.
 *
 * Identity is baked in here, because the bytes are the thing that travels and a superseded copy
 * forwarded to a board has only itself to say what it is (ADR 0072): month, publication instant and
 * publication id are inside the document, so a digest resolves to a moment and not only to a month.
 */
export function monthDocument(identity: PublicationIdentity, content: MonthContent): MonthDocument {
  return {
    documentKind: MONTH_DOCUMENT_KIND,
    documentVersion: MONTH_DOCUMENT_VERSION,
    publication: {
      id: identity.id,
      month: identity.month,
      monthLabel: monthLabel(identity.month),
      // ISO here rather than a `Date` in the document, so the only place a timestamp is formatted is
      // one that cannot vary by machine, and `canonicalise` never has to reach a `toJSON` for it.
      publishedAt: identity.publishedAt.toISOString(),
      publishedBy: identity.publishedBy,
      ...(identity.supersedes != null ? { supersedes: identity.supersedes } : {}),
      ...(identity.reason != null ? { reason: identity.reason } : {}),
    },
    ...(content.assessment != null ? { assessment: content.assessment } : {}),
    runHealth: content.runHealth,
    findingDeltas: content.findingDeltas,
    movement: content.movement,
    actions: content.actions,
    exceptions: content.exceptions,
    outcomes: content.outcomes,
    // Written only when the content carries it, because `canonicalise` is over what is here and a key
    // holding `undefined` is not the same document as one without the key.
    ...(content.review != null ? { review: content.review } : {}),
    trend: content.trend,
  };
}

/** The JSON bytes of a document, canonical so the same document hashes to the same value every time. */
export function monthJson(document: MonthDocument): string {
  return canonicalise(document);
}

/** The header of the flat CSV, named once so the builder below and any reader agree on the columns. */
const CSV_HEADER = [
  'month',
  'publication_id',
  'published_at',
  'section',
  'item',
  'from_or_value',
  'to',
  'note',
] as const;

/**
 * The same publication as a flat CSV, for the reader who works in a spreadsheet.
 *
 * Long format — one row per datum, every row carrying the month and publication id — for the reason
 * the assessment export gives: a spreadsheet has no header block, so a reader who filters to a handful
 * of rows has to still be looking at complete statements. The sections are stacked in a fixed order
 * with a `section` column telling them apart, so a reader can filter to the deltas or the exceptions
 * without the file needing a shape per section. `csv` defuses any cell a spreadsheet would evaluate.
 */
export function monthCsv(document: MonthDocument): string {
  const { id, month, publishedAt } = document.publication;
  const lead = [month, id, publishedAt] as const;
  const rows: string[][] = [[...CSV_HEADER]];

  for (const fact of document.runHealth) rows.push([...lead, 'run health', fact.label, fact.value, '', '']);
  for (const move of document.movement) rows.push([...lead, 'movement', move.label, move.from, move.to, '']);
  for (const delta of document.findingDeltas) {
    rows.push([
      ...lead,
      'finding delta',
      `${delta.control} ${delta.requirement} (${delta.pillar})`,
      delta.from,
      delta.to,
      delta.note ?? '',
    ]);
  }
  for (const action of document.actions) rows.push([...lead, 'actions', action.label, action.value, '', '']);
  for (const exception of document.exceptions) {
    rows.push([
      ...lead,
      'exception',
      `${exception.control} ${exception.requirement}`,
      exception.owner,
      exception.until,
      exception.residual,
    ]);
  }
  for (const outcome of document.outcomes) rows.push([...lead, 'outcomes', outcome.label, outcome.value, '', '']);
  // Empty and absent both produce nothing here, like every other section: a reader filtering to
  // `review` and finding no rows is reading a month with no review on record or none to have, and
  // there is no row that could tell them which without saying more than the document holds.
  for (const fact of document.review ?? []) rows.push([...lead, 'review', fact.label, fact.value, '', '']);
  for (const point of document.trend) {
    rows.push([...lead, 'trend', point.label, point.score, point.comparability, point.note ?? '']);
  }

  return csv(rows);
}
