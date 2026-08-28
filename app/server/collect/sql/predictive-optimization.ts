// The predictive-optimization collector.
//
// One `DESCRIBE CATALOG EXTENDED` per catalog holding tables, reading the row
// `DESCRIBE` labels `Predictive Optimization`.
//
// This replaces a system-table query, and the reason it had to is worth keeping. The
// first version read `system.storage.table_metrics_history`, which carries
// `predictive_optimization_enabled` per table and would have been one cheap statement
// covering the estate exactly. That table is undocumented and empty — ADR 0014 — so the
// query returned no rows, the state resolved to `unknown` on every scan, and three
// controls went unmeasurable behind it: the coverage control itself, and the VACUUM and
// OPTIMIZE controls that read coverage as an applicability precondition. A precondition
// that can never resolve does not gate anything; it just removes the controls behind it
// from the assessment.
//
// So this reads the setting from the place that answers. The cost is a statement per
// catalog rather than one for the estate, which is cheap because catalogs are few — 6 on
// the workspace this was built against, of which 4 are the customer's. The real cost is
// precision: `DESCRIBE CATALOG` reports the catalog's effective setting, and a schema or
// table may override it. Every finding built on this says so rather than implying the
// setting was confirmed per table.

import type { Surface } from '../../scan/surfaces.js';
import type { Collector, CollectorContext, CollectorSpend, SignalId, SignalResult } from '../signal.js';
import { observed, unmeasurable } from '../signal.js';
import type { SqlExecutor } from './collector.js';
import { rowsOf } from './collector.js';
import type { Row } from './rows.js';
import { quoteIdent } from '../../../scripts/sql-identifiers.mjs';
import type {
  CatalogInventory,
  CatalogPredictiveOptimization,
  PredictiveOptimizationCoverage,
  PredictiveOptimizationSetting,
  PredictiveOptimizationState,
} from './shapes.js';

/** The signal naming which catalogs to describe. */
export const CATALOGS_SIGNAL = 'sql:uc.catalogs' as SignalId;

export const PO_SIGNAL = 'describe:predictive_optimization.coverage' as SignalId;

export const PREDICTIVE_OPTIMIZATION_SIGNALS: readonly SignalId[] = [PO_SIGNAL];

/** The label `DESCRIBE CATALOG EXTENDED` gives the setting's row. */
const SETTING_LABEL = 'predictive optimization';

export interface PredictiveOptimizationCollectorOptions {
  readonly executor: SqlExecutor;
  /**
   * Ceiling on catalogs described.
   *
   * Generous, because catalogs are counted in tens where tables are counted in
   * thousands. It exists so that an account with an unusual number of them degrades to a
   * stated partial reading rather than issuing a statement per catalog without limit.
   */
  readonly catalogLimit?: number;
}

export class PredictiveOptimizationCollector implements Collector {
  // The same surface as the per-table pass, because it has the same shape of cost: a
  // statement per object rather than one per estate. Sharing the surface means one
  // budget governs both, which is correct — they compete for the same warehouse.
  readonly surface: Surface = 'describe';
  readonly name = 'predictive-optimization';
  readonly signals: readonly SignalId[] = PREDICTIVE_OPTIMIZATION_SIGNALS;
  readonly requires: readonly SignalId[] = [CATALOGS_SIGNAL];

  private readonly catalogLimit: number;
  private calls = 0;
  private readonly statementIds: string[] = [];

  constructor(private readonly options: PredictiveOptimizationCollectorOptions) {
    this.catalogLimit = options.catalogLimit ?? 50;
  }

  spent(): CollectorSpend {
    return {
      surface: this.surface,
      name: this.name,
      calls: this.calls,
      ...(this.statementIds.length > 0 ? { statementIds: [...this.statementIds] } : {}),
    };
  }

  async collect(ids: readonly SignalId[], context: CollectorContext): Promise<SignalResult[]> {
    const results: SignalResult[] = [];
    for (const id of ids) results.push(await this.collectOne(id, context));
    return results;
  }

  private async collectOne(id: SignalId, context: CollectorContext): Promise<SignalResult> {
    const inventory = context.collected.get(CATALOGS_SIGNAL);
    if (inventory == null || inventory.status !== 'observed') {
      return unmeasurable(
        id,
        'The catalogue of catalogs was not collected, so there was nothing to describe. It comes from the ' +
          'system-table collector, which must run before this one. ' +
          (inventory?.status === 'unmeasurable'
            ? `It reported: ${inventory.unmeasurableReason ?? 'no reason.'}`
            : '')
      );
    }

    const all = (inventory.value as CatalogInventory).catalogs;
    if (all.length === 0) {
      return unmeasurable(
        id,
        'No catalog in this metastore holds a table, so there is nothing for predictive optimization to ' +
          'maintain and no setting worth reading. Reported as unmeasured rather than as coverage of zero, ' +
          'which would read as predictive optimization being switched off.'
      );
    }

    const targets = all.slice(0, this.catalogLimit);
    const started = Date.now();
    const catalogs: CatalogPredictiveOptimization[] = [];
    const unreadable: { catalog: string; reason: string }[] = [];

    for (const target of targets) {
      const quoted = quoteIdent(target.catalog);
      if (quoted == null) {
        unreadable.push({
          catalog: target.catalog,
          reason: 'The catalog name is empty or contains a line break, so DESCRIBE CATALOG EXTENDED was not issued.',
        });
        continue;
      }
      const outcome = await context.scheduler.run({
        surface: this.surface,
        label: `describe-catalog:${target.catalog}`,
        run: async (signal) => {
          // Interpolated rather than bound: DESCRIBE takes an identifier, and identifiers
          // cannot be parameters. The name comes from information_schema rather than from
          // a request, and is quoted through the shared identifier rule so a name containing
          // a backtick cannot terminate the quoting early.
          const raw = await this.options.executor(`DESCRIBE CATALOG EXTENDED ${quoted}`, {}, signal);
          this.calls += 1;
          const statementId = (raw as { statementId?: unknown }).statementId;
          if (typeof statementId === 'string') this.statementIds.push(statementId);
          return rowsOf(raw);
        },
      });

      if (outcome.status === 'ok') {
        catalogs.push({ ...settingOf(outcome.value), catalog: target.catalog, managedTables: target.managedTables });
        continue;
      }

      unreadable.push({
        catalog: target.catalog,
        reason: outcome.status === 'skipped' ? outcome.detail : outcome.failure.message,
      });

      // Budget exhaustion and cancellation apply to the surface, so every remaining
      // catalog would be refused identically. A permission denial is per-catalog, so
      // that one carries on to the next.
      if (outcome.status === 'skipped' && (outcome.reason === 'budget-exhausted' || outcome.reason === 'cancelled')) {
        break;
      }
    }

    if (catalogs.length === 0) {
      return unmeasurable(
        id,
        `None of the ${String(targets.length)} catalogs could be described, so predictive-optimization ` +
          `coverage could not be read. First reason: ${unreadable[0]?.reason ?? 'unknown.'}`
      );
    }

    const value = coverageOf(catalogs, unreadable);
    // Complete only when every catalog that holds a table was read. A partial read is
    // reported as sampled rather than as the whole picture, because the catalogs that
    // went unread are exactly the ones that could turn an enabled estate into a partial
    // one — and an unmeasured catalog must not be counted as an enabled one.
    const complete = catalogs.length >= all.length;
    const reach = inventory.coverage.reach ?? 'metastore';
    return observed(
      id,
      value,
      Date.now() - started,
      complete
        ? { mode: 'complete', reach }
        : {
            mode: 'sampled',
            reach,
            examined: catalogs.length,
            population: all.length,
            basis: 'catalogs holding the most managed tables first, so the largest share of the estate is read',
          }
    );
  }
}

/**
 * The setting for one catalog, from the rows `DESCRIBE CATALOG EXTENDED` returns.
 *
 * The output is a two-column name/value listing rather than a typed row, and the column
 * names differ between `DESCRIBE CATALOG` and `DESCRIBE SCHEMA` (`info_name` versus
 * `database_description_item`). Matching on the label across whichever columns the row
 * has is what lets one parser serve both, and means a third naming does not silently
 * yield "unknown".
 *
 * The value observed live is `ENABLE (inherited from METASTORE metastore_aws_ap_southeast_2)`
 * — a setting followed by an optional parenthesised origin.
 */
function settingOf(rows: readonly Row[]): { setting: PredictiveOptimizationSetting; inheritedFrom?: string } {
  for (const row of rows) {
    const values = Object.values(row).map((value) => (typeof value === 'string' ? value : ''));
    if (!values.some((value) => value.trim().toLowerCase() === SETTING_LABEL)) continue;

    const stated = values.find((value) => value.trim().toLowerCase() !== SETTING_LABEL && value.trim() !== '');
    if (stated == null) break;

    const setting = settingFrom(stated);
    const origin = /inherited from\s+(.+?)\s*\)/i.exec(stated)?.[1];
    return { setting, ...(origin != null ? { inheritedFrom: origin } : {}) };
  }

  // Absent rather than malformed. Older runtimes may not report the setting at all, and
  // an absent setting is not a disabled one.
  return { setting: 'unknown' };
}

function settingFrom(stated: string): PredictiveOptimizationSetting {
  const first = (stated.trim().split(/[\s(]/)[0] ?? '').toUpperCase();
  if (first === 'ENABLE') return 'enable';
  if (first === 'DISABLE') return 'disable';
  if (first === 'INHERIT') return 'inherit';
  return 'unknown';
}

/**
 * Collapse per-catalog settings into the estate summary a precondition reads.
 *
 * Weighted by managed tables rather than by catalog, because the share that matters is
 * the share of the estate covered. Four of five catalogs enabled is not 80% coverage if
 * the fifth holds most of the tables.
 *
 * `inherit` counts as not enabled. It means the setting was not decided here, and
 * `DESCRIBE` reports the effective value with its origin — so a catalog inheriting an
 * enabled metastore reads as `ENABLE (inherited from …)`, not as `INHERIT`. A literal
 * `INHERIT` therefore means the chain above it did not resolve to enabled either.
 */
function coverageOf(
  catalogs: readonly CatalogPredictiveOptimization[],
  unreadable: readonly { readonly catalog: string; readonly reason: string }[]
): PredictiveOptimizationCoverage {
  const managedTables = catalogs.reduce((total, catalog) => total + catalog.managedTables, 0);
  const enabledTables = catalogs
    .filter((catalog) => catalog.setting === 'enable')
    .reduce((total, catalog) => total + catalog.managedTables, 0);

  const state = stateOf(catalogs, managedTables, enabledTables);
  return { managedTables, enabledTables, catalogs, unreadable, state, summary: state };
}

function stateOf(
  catalogs: readonly CatalogPredictiveOptimization[],
  managedTables: number,
  enabledTables: number
): PredictiveOptimizationState {
  // Every setting unreadable is not the same as every setting off. Saying `disabled`
  // here would turn a runtime that does not report the field into an estate that
  // switched predictive optimization off, and the VACUUM control would then start
  // demanding manual maintenance that may already be automatic.
  if (catalogs.every((catalog) => catalog.setting === 'unknown')) return 'unknown';
  // Settings read, but no managed table for them to act on — an all-external estate.
  // `disabled` is right rather than a evasion, because this state is read as "predictive
  // optimization is not maintaining these tables", which is true: it only acts on managed
  // ones. The control that scores coverage checks the table count itself and reports
  // not-applicable, so this does not become a failure.
  if (managedTables === 0) return 'disabled';
  if (enabledTables === managedTables) return 'enabled';
  if (enabledTables === 0) return 'disabled';
  return 'partial';
}
