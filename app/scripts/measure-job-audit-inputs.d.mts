/** Types for measure-job-audit-inputs.mjs, which is JavaScript so it can run from the CLI unbuilt. */

/** One probe: whether it ran, and what it said if it did. */
export interface Probe {
  readonly label: string;
  readonly ok: boolean;
  readonly rows?: readonly Readonly<Record<string, string | null>>[];
  readonly error?: string;
}

/**
 * A share, its population, and — where there is no share — which of the two reasons.
 *
 * `unknown` distinguishes "the probe could not look" from "the probe looked and there is nothing of this kind
 * here". Both leave `share` null and they are findings about different things.
 */
export interface Reading {
  readonly share: number | null;
  readonly of: number | null;
  readonly unknown: string | null;
}

export interface JobAuditInputs {
  readonly runFinishedAt: string;
  /** The estate, which is also the recording's filename. */
  readonly profile?: string;
  /** Where the numbers actually came from, which the profile alone does not establish. */
  readonly host?: string;
  /** Which warehouse ran the probes, because on a shared estate that is part of the apparatus. */
  readonly warehouse?: string;
  readonly lookbackDays: number;
  readonly retentionDays: number;
  readonly readings: Readonly<Record<string, Reading>>;
  readonly probes: readonly Probe[];
}

/**
 * The task timeline reduced to one row per task run, and the classic run-cluster pairs from it.
 *
 * Shared with `measure-job-rule-inputs.mjs` rather than copied, so a reading about rules D and E is a reading
 * about the population this script's own numbers describe.
 */
export const TASK_RUNS: string;
export const CLASSIC_TASK_CLUSTERS: string;

export function probe(label: string, statement: string): Promise<Probe>;

export function only(probes: readonly Probe[], label: string): Readonly<Record<string, string | null>> | null;

export function count(row: Readonly<Record<string, string | null>> | null | undefined, key: string): number | null;

export function share(part: number | null, whole: number | null): Reading;

export function said(reading: Reading): string;
