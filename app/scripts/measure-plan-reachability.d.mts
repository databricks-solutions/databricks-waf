/** Types for measure-plan-reachability.mjs, which is JavaScript so it can run from the CLI unbuilt. */

export interface HistoryRow {
  readonly computeType?: string | null;
  readonly warehouseId?: string | null;
}

export type SkipReason = 'not-warehouse-compute' | 'no-warehouse-id' | 'warehouse-outside-workspace';

export type Outcome = 'available' | 'no-plan' | 'not-retrievable' | 'error' | 'unknown-state';

export interface PlanResponseBody {
  readonly plans_state?: string | null;
}

export function skipReason(row: HistoryRow, localWarehouseIds: ReadonlySet<string>): SkipReason | null;

export function interpret(status: number, body: PlanResponseBody | null): Outcome;
