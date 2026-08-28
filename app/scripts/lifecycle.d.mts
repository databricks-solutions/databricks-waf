export type LifecycleAction = 'validate' | 'install' | 'upgrade' | 'rollback' | 'uninstall';

export interface LifecycleOptions {
  readonly action: LifecycleAction;
  readonly profile: string;
  readonly target: string;
  readonly apply: boolean;
  readonly confirm?: string;
  readonly to?: string;
  readonly fromDeployment?: string;
  readonly catalogs?: string;
  readonly sharing: boolean;
}

export interface BundleFacts {
  readonly bundle: string;
  readonly target: string;
  readonly host: string;
  readonly actor: string;
  readonly app: string;
  readonly appKey: string;
  readonly job: string;
  readonly warehouse: string;
  readonly postgresBranch: string;
  readonly postgresDatabase: string;
  readonly scopes: readonly string[];
  readonly scheduleClient?: string;
  readonly schedulePaused: boolean;
  readonly workspaceRoot: string;
}

export interface DeploymentVerification {
  readonly deploymentId: string;
  readonly url: string;
  readonly appState: string;
  readonly deploymentState: string;
}

export interface UninstallInventory {
  readonly removes: string[];
  readonly retains: string[];
  readonly deploymentId: string;
  readonly jobId: string;
  readonly scheduledRevocation: string;
}

export interface LifecycleRunResult {
  readonly facts: BundleFacts & { readonly profile: string };
  readonly plan: readonly { readonly resource: string; readonly action: string }[];
  readonly output: string[];
  readonly inventory?: UninstallInventory;
  readonly before?: unknown;
  readonly verified?: DeploymentVerification;
}

export function parseLifecycleArgs(argv: readonly string[]): LifecycleOptions;
export function commandEnvironment(
  overrides?: Readonly<Record<string, string>>,
  inherited?: Readonly<Record<string, string | undefined>>
): Record<string, string | undefined>;
export function bundleFacts(resolved: unknown): BundleFacts;
export function planFacts(answer: unknown): Array<{ resource: string; action: string }>;
export function isIdempotent(answer: unknown): boolean;
export function uninstallToken(facts: BundleFacts, profile: string, inventory: UninstallInventory): string;
export function uninstallInventory(
  facts: BundleFacts,
  summary: unknown,
  deployed: unknown,
  scheduledRevocation: string
): UninstallInventory;
export function verifyDeployment(deployed: unknown, facts: BundleFacts): DeploymentVerification;
export function scheduleArgs(
  options: LifecycleOptions,
  facts: BundleFacts,
  behaviour?: { revoke?: boolean }
): string[] | undefined;

export interface LifecycleRunner {
  run(
    command: string,
    args: string[],
    options?: { json?: boolean; allow?: number[]; env?: Record<string, string> }
  ): unknown;
}

export class CommandRunner implements LifecycleRunner {
  run(
    command: string,
    args: string[],
    options?: { json?: boolean; allow?: number[]; env?: Record<string, string> }
  ): unknown;
}

export interface DeploymentPollOptions {
  readonly attempts?: number;
  readonly pause?: (milliseconds: number) => void;
  readonly intervalMs?: number;
}

export function waitForRequestedDeployment(
  runner: LifecycleRunner,
  options: LifecycleOptions,
  appName: string,
  preRun: unknown,
  poll?: DeploymentPollOptions
): { app: unknown; deploymentId: string };

export function runLifecycle(
  options: LifecycleOptions,
  runner?: LifecycleRunner,
  beforeMutation?: (lines: readonly string[]) => void,
  deploymentPoll?: DeploymentPollOptions
): LifecycleRunResult;
