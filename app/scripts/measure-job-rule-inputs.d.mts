/** Types for measure-job-rule-inputs.mjs, which is JavaScript so it can run from the CLI unbuilt. */

import type { Probe, Reading } from './measure-job-audit-inputs.d.mts';

export interface JobRuleInputs {
  readonly runFinishedAt: string;
  /** The estate, which is also the recording's filename. */
  readonly profile?: string;
  /** Where the numbers came from, which the profile alone does not establish. */
  readonly host?: string;
  /** Which warehouse ran the probes, because on a shared estate that is part of the apparatus. */
  readonly warehouse?: string;
  readonly lookbackDays: number;
  readonly retentionDays: number;
  /** The magnitudes the rate was cut at, in MiB per node-minute. */
  readonly rateCutsMib: readonly number[];
  readonly readings: Readonly<Record<string, Reading>>;
  readonly probes: readonly Probe[];
}

/** The classic run-cluster pairs with their network, CPU and node-minute figures. */
export const NETWORK_PER_PAIR: string;

export const RATE_CUTS: readonly number[];
