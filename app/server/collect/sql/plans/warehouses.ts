// The warehouses this workspace can see, which is what decides whether a plan can be fetched at all.
//
// `retrievable.ts` needs a set of local warehouse ids and is explicit that an empty one skips
// everything. This is where it comes from, and the source matters more than it looks.
//
// The obvious alternative is the `sql:compute.warehouses` signal the advisory run already collects, at no
// extra call. It is the wrong source. That statement reads `system.compute.warehouses`, a metastore table
// carrying every workspace that shares the metastore — which is the *same* over-wide set that makes the
// plan endpoint return 404 in the first place. Narrowing it back down would mean filtering on a workspace
// id, and the thing being established is precisely which warehouses this workspace holds. `GET
// /api/2.0/sql/warehouses` answers that directly, and it is what `33k` measured the 96.79% reachable
// share with, so the census that `retrievable.test.ts` pins its drift guard against describes this list
// and not another one.
//
// Through the SDK rather than by hand, unlike the plan fetch beside it: `WarehousesService.list` exists,
// paginates itself, and retries, which is what makes `rest`'s `clientRetries: true` true of this call.
//
// What the SDK does not do is put the call under a surface, and this file said the opposite until `41c` —
// that the client "puts a retrying client under the `rest` surface". A retrying client is not a scheduled
// one. `advise/runner.ts` submits this as a `rest` task and is the only caller; calling it directly opts
// out of the budget, the concurrency bound and cancellation, which is what `ADR 0010` is for.

import type { WorkspaceClientFactory } from '../../rest/client.js';

/**
 * Every warehouse id in the workspace the app runs in.
 *
 * Throws rather than returning an empty set when the list cannot be read. The two are not the same fact
 * and the caller has to tell them apart: a workspace with no warehouses cannot have run any of the
 * statements being nominated, whereas a workspace whose list was refused may have run all of them. Both
 * end in fetching no plans, and only the second is worth telling the reader about.
 *
 * Still a throw now that the caller schedules it, and that is the point: the scheduler is what turns a
 * raised error into a classified outcome, and a function that swallowed its own refusal would hand it an
 * empty set indistinguishable from a workspace with no warehouses.
 */
export async function localWarehouseIds(client: WorkspaceClientFactory): Promise<Set<string>> {
  const workspace = await client();
  const ids = new Set<string>();
  for await (const warehouse of workspace.warehouses.list({})) {
    if (warehouse.id != null && warehouse.id !== '') ids.add(warehouse.id);
  }
  return ids;
}
