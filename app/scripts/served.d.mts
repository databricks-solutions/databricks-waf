/**
 * Types for served.mjs, which is JavaScript so it can run from the CLI unbuilt.
 *
 * Only what a TypeScript file imports is declared, which today is what served.test.ts asserts. The
 * recording's own shape is declared here rather than inferred, because the test's whole subject is which
 * fields the prose is allowed to be built from — an untyped import would let a test pass against a field
 * that no longer exists.
 */

/** What the platform said was running, when it was asked. */
export interface Serving {
  /** When the platform was asked, which is what every present-tense reading here is relative to. */
  readonly asked: string;
  readonly estate: string;
  readonly app: string;
  readonly origin: string;
  readonly deploymentId: string;
  /** The platform's create time for the active deployment. */
  readonly deployedAt: string;
  readonly deploymentState: string;
  readonly appState: string;
  /** The command that produced this, so a reading can be retaken the way it was taken. */
  readonly source: string;
}

/** What a drive of the served app did. Written by drive-labs.mjs, which is the only thing that knows. */
export interface Drive {
  readonly at: string;
  readonly estate: string;
  readonly origin: string;
  /** The deployment being served at the moment of the drive. The join with `Serving`. */
  readonly deploymentId: string;
  readonly drove: number;
  readonly declared: number;
  readonly failures: number;
  readonly unreached?: readonly string[];
}

export interface Served {
  readonly what?: string;
  readonly served?: Serving;
  readonly driven?: Drive;
}

/** The generated block for docs/estates.md. Absolute facts only — see the comment on the source. */
export function stamp(recording: Served): string;

/** How long ago, in hours below two days and in days above. */
export function ago(from: string, to: string): string;

/**
 * Records a drive of the served app, refusing a local origin and an origin the profile does not serve.
 * Asks the platform for the deployment id, so it is not a network-free call.
 */
export function recordDriven(drive: {
  origin: string;
  profile: string;
  drove: number;
  declared: number;
  failures: number;
  unreached: readonly string[];
}): void;
