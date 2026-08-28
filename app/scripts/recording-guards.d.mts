/** Types for recording-guards.mjs, which is JavaScript so the measurement scripts can run from the CLI unbuilt. */

/** The only field of a recording either guard reads. */
export interface HostedRecording {
  readonly host?: string;
}

export function refusalToMisname(profile: string, host: string, configured: string | null): string | null;

export function refusalToOverwrite(path: string, existing: HostedRecording | null, host: string): string | null;

export function refusalToStray(path: string, profile: string): string | null;

export function hostTheProfileNames(profile: string): string | null;

export function refuseUnlessNamedForItsEstate(path: string, profile: string, host: string): void;

