// What the imports list shows about an envelope, computed once at import rather than on every read.
//
// The list page shows seven facts about each collection and none of them is the collection. Six are
// scalars the envelope carries at its top level; the seventh is three counts over `probes`. Computing
// them needs the whole envelope, and the envelope is a `jsonb` column that Postgres stores out of line
// once it passes about two kilobytes — which every real one does. So a list of ten imports was ten
// detoasts and ten `JSON.parse`s of a document the answer throws away.
//
// Measured on labs, an envelope is 25.8 KiB and that read costs 0.09 ms per import, which is nothing.
// The reason this module exists anyway is the ceiling rather than the reading: `read.ts` accepts eight
// megabytes, and an envelope grown to that cap costs 44 ms for a single import and 281 ms for ten.
// `docs/design/import-list-cost.md` has both numbers and what they were taken with.
//
// This is the arrangement `advisories.considered` already uses, and for the same reason stated in the
// comment above that column: promoted to its own storage is only what a list shows, because the
// alternative is parsing every stored body to draw one.
//
// The cost of it is a second record of a fact the body already holds. That is why `summarise` is here
// and not beside either caller — the import path writes what it returns, and the read path renders
// what the import path wrote, so a change to what a summary counts is one edit and the stored rows
// that predate it are recomputed by the fallback in `PostgresEvidenceImportStore.summaries`.

import type { Envelope } from './envelope.js';

/** The facts the imports list shows, all of them derived from an envelope and none of them it. */
export interface EvidenceSummary {
  /**
   * When the collection ran, as the script wrote it.
   *
   * The envelope's own text rather than the `generated_at` column, which is that text parsed. They
   * are the same instant and not the same string — the column round-trips to millisecond precision
   * the script did not write — and the digest covers the text. Reading it from here keeps the list
   * showing what the file says.
   */
  readonly generatedAt: string;
  /**
   * Who the collecting CLI was authenticated as, when it could say.
   *
   * Not the importer, and the distinction is the one `ImportedEvidence.importedBy` documents: an
   * account admin runs the script and sends the file to whoever is running the assessment.
   */
  readonly collectedBy?: string;
  readonly workspaceTier: boolean;
  readonly accountTier: boolean;
  /** Probes that returned a reading. */
  readonly observed: number;
  /** Probes the platform refused or errored, which is a different thing from one that was skipped. */
  readonly refused: number;
  /** Distinct requirements the probes in this file speak to. */
  readonly requirements: number;
  readonly scriptVersion: string;
}

/** What the readings in a file speak to, counted rather than listed, for the page's summary line. */
export function summarise(envelope: Envelope): EvidenceSummary {
  const requirements = new Set<string>();
  let observed = 0;
  let refused = 0;
  for (const probe of envelope.probes) {
    for (const control of probe.controls) requirements.add(control);
    if (probe.status === 'observed') observed += 1;
    if (probe.status === 'denied' || probe.status === 'error') refused += 1;
  }

  const collectedBy = envelope.tiers.workspace.identity?.username;
  return {
    generatedAt: envelope.generatedAt,
    ...(collectedBy != null ? { collectedBy } : {}),
    workspaceTier: envelope.tiers.workspace.ran,
    accountTier: envelope.tiers.account.ran,
    observed,
    refused,
    requirements: requirements.size,
    scriptVersion: envelope.script.version,
  };
}

/**
 * A stored summary back into one, or nothing when the column holds something else.
 *
 * Nothing rather than a partial record, because the caller's fallback is to recompute from the body
 * and a half-read summary would suppress it. Every field is checked for that reason: a row written by
 * a version that counted fewer things is a row this should decline, not one it should pad with zeroes
 * and render as though the count were real.
 */
export function summaryFrom(value: unknown): EvidenceSummary | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const held = value as Record<string, unknown>;

  const { generatedAt, collectedBy, workspaceTier, accountTier, observed, refused, requirements, scriptVersion } =
    held;
  if (typeof generatedAt !== 'string' || generatedAt === '') return undefined;
  if (typeof workspaceTier !== 'boolean' || typeof accountTier !== 'boolean') return undefined;
  if (!Number.isInteger(observed) || !Number.isInteger(refused) || !Number.isInteger(requirements)) return undefined;
  if (typeof scriptVersion !== 'string') return undefined;
  if (collectedBy != null && typeof collectedBy !== 'string') return undefined;

  return {
    generatedAt,
    ...(typeof collectedBy === 'string' ? { collectedBy } : {}),
    workspaceTier,
    accountTier,
    observed: observed as number,
    refused: refused as number,
    requirements: requirements as number,
    scriptVersion,
  };
}
