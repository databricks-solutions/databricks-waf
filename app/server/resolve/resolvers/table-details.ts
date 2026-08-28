// Shared reading of the per-table pass.
//
// Four controls across three pillars now reduce `describe:storage.table_details` to a share, and
// each of them has the same two edge cases to get right before it can say anything: nothing was
// described, and something was described but the property being read is absent. Both were handled
// once in the layout resolvers and would have been reimplemented per resolver from here, which is
// how one control comes to report an unread estate as a clean one.

import type { SignalId } from '../../collect/signal.js';
import type { TableDetail, TableDetails } from '../../collect/sql/shapes.js';
import type { Resolution } from '../resolver.js';
import { notApplicable, unmeasured } from './helpers.js';

export const DETAILS = 'describe:storage.table_details' as SignalId;

/**
 * The answer when the per-table pass described nothing, or undefined when it described something
 * and the control should carry on.
 *
 * Every control reading this signal reduces the described tables to a share, and a share over an
 * empty population is zero — which reads as "no over-partitioned tables", "no clustering strategy"
 * and "no shortened retention" from the same absence of evidence, one a false pass and two false
 * failures. The collector already refuses to emit an empty result, so reaching this is a bug rather
 * than an estate; it is handled anyway because the cost of being wrong here is a fabricated finding.
 *
 * `eligibleTables` is what separates the two answers. Zero eligible tables is a measurement of the
 * metastore — there is nothing to lay out — so the control leaves the denominator. Eligible tables
 * that went undescribed is a failure of the pass, so the control stays in and reports itself
 * unmeasured.
 */
export function describedNothing(details: TableDetails): Resolution | undefined {
  if (details.tables.length > 0) return undefined;
  if (details.eligibleTables === 0) {
    return notApplicable(
      'The metastore holds no Delta tables the scanning identity can see, so there is no table layout to assess.'
    );
  }
  return unmeasured(
    `None of the ${details.eligibleTables.toLocaleString('en-US')} eligible tables were described, so this is ` +
      'unmeasured rather than clean. Re-running the scan will pick it up if the per-table budget was the limit.'
  );
}

export function nameOf(table: TableDetail): string {
  return `${table.catalog}.${table.schema}.${table.table}`;
}

/** The described tables read in the scan window, or all of them where lineage recorded no reads. */
export function activelyRead(details: TableDetails): readonly TableDetail[] {
  const active = details.tables.filter((table) => table.readEvents > 0);
  return active.length > 0 ? active : details.tables;
}

/** Up to `limit` names, with a count of the rest, for evidence that locates a finding. */
export function someOf(tables: readonly TableDetail[], limit: number, describe: (table: TableDetail) => string): string {
  const shown = tables.slice(0, limit).map(describe).join('; ');
  const rest = tables.length - Math.min(limit, tables.length);
  return rest > 0 ? `${shown}, and ${rest.toLocaleString('en-US')} more` : shown;
}
