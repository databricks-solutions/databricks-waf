// The monthly cadence as the browser receives it.
//
// The write path freezes a denormalised document (ADR 0072). The page has two read shapes over that
// work: the live preview, which moves with runs and decisions, and a published copy, which does not.
// Both carry the same eight sections as strings already resolved — the client does not join titles,
// scores or comparability itself.

import type { GateEligibilityPayload } from './eligibility';

/** A calendar month, `YYYY-MM`. */
export type MonthIdPayload = string;

/** A named figure the month reports. Both sides are strings already. */
export interface MonthFactPayload {
  readonly label: string;
  readonly value: string;
}

/** A figure that moved over the month, carrying both ends. */
export interface MonthMovementPayload {
  readonly label: string;
  readonly from: string;
  readonly to: string;
}

/** A requirement whose finding changed, denormalised. */
export interface MonthDeltaPayload {
  readonly control: string;
  readonly requirement: string;
  readonly pillar: string;
  readonly from: string;
  readonly to: string;
  readonly note?: string;
}

/** An accepted risk in force at the month's close. */
export interface MonthExceptionPayload {
  readonly control: string;
  readonly requirement: string;
  readonly owner: string;
  readonly residual: string;
  readonly until: string;
}

/** One point of the monthly trend, with the server's comparability against the series base. */
export interface MonthTrendPointPayload {
  readonly month: MonthIdPayload;
  readonly label: string;
  readonly score: string;
  readonly comparability: 'permitted' | 'caveat' | 'refused';
  readonly note?: string;
}

/** Everything a month reports, already resolved to the strings it will display. */
export interface MonthContentPayload {
  readonly runHealth: readonly MonthFactPayload[];
  readonly findingDeltas: readonly MonthDeltaPayload[];
  readonly movement: readonly MonthMovementPayload[];
  readonly actions: readonly MonthFactPayload[];
  readonly exceptions: readonly MonthExceptionPayload[];
  readonly outcomes: readonly MonthFactPayload[];
  /**
   * What the review of the run this month reports was made of: whether it was finalised, how many
   * pillars were confirmed, which were skipped, how many answers the confirms cited.
   *
   * Three states, not two. Present with rows is the review. Present and empty is this app having no
   * review record for that run — which is not "nobody reviewed it". Absent is a payload that does not
   * carry the section at all: a month frozen before the section existed, whose bytes cannot be asked.
   * A live preview always sends it, so absent only reaches the page from a stored document.
   */
  readonly review?: readonly MonthFactPayload[];
  readonly trend: readonly MonthTrendPointPayload[];
}

/** Where the closure rule read dates, and whether a schedule supplied that zone. */
export interface PublishingZonePayload {
  readonly id: string;
  readonly source: 'schedule' | 'default';
}

/**
 * The live reading of a month, before anybody publishes it.
 *
 * Moves with runs and decisions. Carries no digest — nothing yet exists whose digest a recipient
 * could check. `closedNote` is the same sentence publish would refuse with, when the month is still
 * open; the page displays it rather than composing a second one.
 */
export interface MonthPreviewPayload {
  readonly month: MonthIdPayload;
  readonly label: string;
  readonly durable: boolean;
  readonly closed: boolean;
  readonly zone: PublishingZonePayload;
  readonly content: MonthContentPayload;
  /** The complete server publication gate. A browser boolean cannot widen it. */
  readonly eligibility: GateEligibilityPayload;
  /** The exact review that must be completed before publication, when one exists. */
  readonly reviewId?: string;
  /** Technical provenance for the run this moving preview currently uses. */
  readonly closingRun?: {
    readonly id: string;
    readonly finishedAt: string;
  };
  /** Present while the month is still open: the server's own closure refusal. */
  readonly closedNote?: string;
  /** The calendar date publish becomes available, present while the month is still open. */
  readonly availableFrom?: string;
  /**
   * Present while the run that closes this month has a review nobody has finished: the server's own
   * refusal, in the same shape as `closedNote`.
   *
   * Absent means publish is not held for this reason, which covers three states that are not the
   * same as each other and are the same answer here — the review is finished, no run closes the
   * month, or this install keeps no reviews and has no record either way. The page shows the
   * sentence; it may not infer from its absence that somebody reviewed anything.
   */
  readonly unreviewedNote?: string;
  /** The closing run is pre-release or candidate evidence and therefore cannot be published. */
  readonly methodologyNote?: string;
}

/** One publication of a month, as the standing read reports it: identity, standing and digest, no bytes. */
export interface PublishedMonthPayload {
  readonly id: string;
  readonly ordinal: number;
  readonly total: number;
  readonly current: boolean;
  readonly publishedAt: string;
  readonly publishedBy: string;
  readonly documentVersion: number;
  readonly digest: string;
  readonly supersedes?: string;
  readonly reason?: string;
  readonly supersededAt?: string;
}

/** A month's publications in order, so a page can read standing without re-sorting. */
export interface MonthStandingPayload {
  readonly month: MonthIdPayload;
  readonly label: string;
  readonly durable: boolean;
  readonly standing: readonly string[];
  readonly publications: readonly PublishedMonthPayload[];
}

/** One row of the published-months list. */
export interface MonthSummaryPayload {
  readonly month: MonthIdPayload;
  readonly label: string;
  readonly publications: number;
  readonly standing: number;
  readonly latest: {
    readonly id: string;
    readonly publishedAt: string;
    readonly publishedBy: string;
    readonly digest: string;
  };
}

/** The months that have been published, plus the wall-clock month the preview can open on. */
export interface MonthsPayload {
  readonly durable: boolean;
  readonly currentMonth: MonthIdPayload;
  readonly zone: PublishingZonePayload;
  readonly months: readonly MonthSummaryPayload[];
}

/** The answer to a publish or supersede. */
export interface PublishedMonthResultPayload {
  readonly id: string;
  readonly month: MonthIdPayload;
  readonly publishedAt: string;
  readonly publishedBy: string;
  readonly documentVersion: number;
  readonly digest: string;
  readonly supersedes?: string;
}

/** The frozen document, as the JSON download parses. */
export interface MonthDocumentPayload {
  readonly documentKind: 'databricks-waf-month';
  readonly documentVersion: number;
  readonly publication: {
    readonly id: string;
    readonly month: MonthIdPayload;
    readonly monthLabel: string;
    readonly publishedAt: string;
    readonly publishedBy: string;
    readonly supersedes?: string;
    readonly reason?: string;
  };
  readonly runHealth: readonly MonthFactPayload[];
  readonly findingDeltas: readonly MonthDeltaPayload[];
  readonly movement: readonly MonthMovementPayload[];
  readonly actions: readonly MonthFactPayload[];
  readonly exceptions: readonly MonthExceptionPayload[];
  readonly outcomes: readonly MonthFactPayload[];
  /**
   * Absent on months published before the section existed: they carry the same `documentVersion`, so
   * a reader handles its absence rather than reading a missing section as a fact about a review.
   */
  readonly review?: readonly MonthFactPayload[];
  readonly trend: readonly MonthTrendPointPayload[];
}
