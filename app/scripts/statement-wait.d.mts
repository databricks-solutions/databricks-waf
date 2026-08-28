/** Types for statement-wait.mjs, which is JavaScript so the measurement scripts can run from the CLI unbuilt. */

/** As much of a Statement Execution API response as waiting for one needs to read. */
export interface Settling {
  readonly statement_id?: string;
  readonly status?: { readonly state?: string };
  /** Present only when this script stopped waiting: whether the warehouse accepted the cancellation. */
  readonly cancelled?: boolean;
  readonly [field: string]: unknown;
}

export interface WaitOptions {
  /** The script's own authenticated call, which throws on a status the API refused. */
  readonly call: (path: string, init?: { readonly method?: string }) => Promise<Settling>;
  /** The caller's existing poll budget, unchanged by `74`. */
  readonly polls: number;
  readonly pollIntervalMs?: number;
}

export const PENDING: ReadonlySet<string>;

export function settled(response: Settling, options: WaitOptions): Promise<Settling>;

export function abandoned(response: Settling, seconds: number): string | null;
