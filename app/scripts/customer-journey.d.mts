export interface JourneySourceState {
  readonly ancestor?: boolean;
  readonly changed?: readonly string[];
}

export function journeyProblems(
  recording: unknown,
  served: unknown,
  live: unknown,
  source?: JourneySourceState
): string[];

export function deployedSourceChanges(paths: readonly string[]): string[];

export function customerJourneyEvidenceCommit(history?: (...args: string[]) => string): string;

export interface HistoricalEvidence {
  readonly problems: string[];
  readonly served?: unknown;
  readonly live?: unknown;
}

export function historicalEvidence(commit: string, read?: (commit: string, path: string) => string): HistoricalEvidence;

export const RECORDING: string;
export const SERVED: string;
export const LIVE: string;
