// Types for `guidance-prose.mjs`, which stays JavaScript because the check that imports it is a
// plain Node script run straight from source with no build step.

/** How alike two entries may read before it is a fault. Measured against the corpus, not chosen. */
export const SIMILAR: number;

/** The named regulations a claim would be made about. */
export const REGULATIONS: RegExp;

/** One regulation an entry names, with the tokens a citation of it would carry. */
export interface NamedRegulation {
  readonly named: string;
  readonly token: string;
  readonly accepted: readonly string[];
}

/** The regulations an entry names without citing a source that names them too. */
export function uncitedRegulations(entry: RawGuidanceEntry | null | undefined): NamedRegulation[];

/** The fields compared for near-duplication, being the four that carry a recommendation. */
export const COMPARED: readonly string[];

/** One guidance entry, as the YAML holds it and the check reads it. */
export type RawGuidanceEntry = Record<string, unknown>;

/** Every sentence of an entry a reader sees, advice included. */
export function prose(entry: RawGuidanceEntry | null | undefined): string[];

/** The words worth comparing, being the ones over three letters, deduplicated. */
export function significant(text: string): Set<string>;

export function jaccard(one: ReadonlySet<string>, other: ReadonlySet<string>): number;

/** Two entries saying nearly the same thing in the same field. */
export interface NearDuplicate {
  readonly one: string;
  readonly other: string;
  readonly field: string;
  readonly overlap: number;
}

/** Pairs at or over the threshold, worst first. */
export function nearDuplicates(
  entries: readonly (readonly [string, RawGuidanceEntry])[],
  threshold?: number
): NearDuplicate[];

/** The closest pair in a corpus at any distance, which is what the threshold was set against. */
export function closestPair(
  entries: readonly (readonly [string, RawGuidanceEntry])[]
): NearDuplicate | undefined;
