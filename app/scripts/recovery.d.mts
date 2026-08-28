export type RecoveryAction = 'backup' | 'restore' | 'cleanup';

export interface ExpectedRecoveryRecords {
  readonly result?: string;
  readonly review?: string;
  readonly action?: string;
  readonly publication?: string;
}

export interface RecoveryOptions {
  readonly action: RecoveryAction;
  readonly profile: string;
  readonly target: string;
  readonly archive: string;
  readonly apply: boolean;
  readonly plaintext: boolean;
  readonly recipient?: string;
  readonly retainUntil?: string;
  readonly databaseId?: string;
  readonly confirm?: string;
  readonly expected: ExpectedRecoveryRecords;
}

export interface RecoveryContext {
  readonly bundle: string;
  readonly target: string;
  readonly profile: string;
  readonly host: string;
  readonly actor: string;
  readonly app: string;
  readonly appClientId: string;
  readonly expectedRole: string;
  readonly appRoleResource: string;
  readonly branch: string;
  readonly database: string;
}

export interface RecoveryRunnerLike {
  run(
    command: string,
    args: string[],
    options?: {
      json?: boolean;
      allow?: number[];
      env?: Record<string, string>;
      cwd?: string;
    }
  ): unknown;
}

export interface RecoveryResult {
  readonly context: RecoveryContext;
  readonly output: string[];
  readonly manifest?: Record<string, unknown>;
  readonly source?: Record<string, unknown>;
  readonly target?: Record<string, unknown>;
  readonly targetResource?: string;
  readonly token?: string;
  readonly inspection?: Record<string, unknown>;
  readonly receipt?: Record<string, unknown>;
  readonly receiptPath?: string;
}

export function parseRecoveryArgs(argv: readonly string[]): RecoveryOptions;
export function parseDatabaseResource(name: string): { branch: string; databaseId: string };
export function cleanupToken(
  context: RecoveryContext,
  manifest: { archive: { sha256: string } },
  databaseResource: string,
  recoveryOwnerResource?: string,
  recoveryDatabasePresent?: boolean
): string;

export class RecoveryRunner implements RecoveryRunnerLike {
  run(
    command: string,
    args: string[],
    options?: {
      json?: boolean;
      allow?: number[];
      env?: Record<string, string>;
      cwd?: string;
    }
  ): unknown;
}

export function runRecovery(
  options: RecoveryOptions,
  runner?: RecoveryRunnerLike,
  beforeMutation?: (lines: readonly string[]) => void
): RecoveryResult;
