// The per-table collector.
//
// One `DESCRIBE DETAIL` per sampled table, on its own scheduler surface. It is separate
// from the system-table collector for a reason that is easy to lose: every signal there
// is one statement covering the whole estate, whereas this one issues a statement per
// table. The two scale differently against the same warehouse, so they get separate
// budgets even though they share a concurrency limiter.
//
// Why `DESCRIBE DETAIL` and not `ANALYZE … COMPUTE STORAGE METRICS`: the former reads the
// Delta log, the latter lists files. Measured on labs, the log read is sub-second while
// the file listing is documented as taking minutes to hours on large tables. That gap is
// why a sample here can be generous and a sample there cannot, and why vacuumable and
// time-travel bytes — which only the expensive path carries — are a separate tier. ADR 0014.
//
// This collector reads its sample from a signal another collector produced, which makes
// it the only one with an ordering dependency. That dependency is checked rather than
// assumed: if the sample is absent the signal reports why, instead of quietly describing
// nothing and reporting an estate with no layout problems.

import type { Surface } from '../../scan/surfaces.js';
import type { Collector, CollectorContext, CollectorSpend, SignalId, SignalResult } from '../signal.js';
import { observed, unmeasurable } from '../signal.js';
import type { SqlExecutor } from './collector.js';
import { jsonArray, jsonMap, type SampleSelection, type TableDetail, type TableDetails } from './shapes.js';
import { count, text, type Row } from './rows.js';
import { rowsOf } from './collector.js';
import { quoteIdent } from '../../../scripts/sql-identifiers.mjs';

/** The signal this collector needs another collector to have produced first. */
export const SAMPLE_SIGNAL = 'sql:storage.sample_selection' as SignalId;

/** Named as well as listed, so anything describing this signal cannot depend on array order. */
export const TABLE_DETAILS_SIGNAL = 'describe:storage.table_details' as SignalId;

export const DESCRIBE_SIGNALS: readonly SignalId[] = [TABLE_DETAILS_SIGNAL];

export interface DescribeCollectorOptions {
  readonly executor: SqlExecutor;
  /**
   * Ceiling on tables described, independent of the scheduler's budget.
   *
   * Both limits are real and neither is redundant: the scheduler protects the warehouse
   * from the whole scan, this protects the reader from a sample so large that the finding
   * takes longer to read than to produce.
   */
  readonly sampleLimit?: number;
}

export class DescribeCollector implements Collector {
  readonly surface: Surface = 'describe';
  readonly name = 'table-detail';
  readonly signals: readonly SignalId[] = DESCRIBE_SIGNALS;
  readonly requires: readonly SignalId[] = [SAMPLE_SIGNAL];

  private readonly sampleLimit: number;
  private calls = 0;
  private readonly statementIds: string[] = [];

  constructor(private readonly options: DescribeCollectorOptions) {
    this.sampleLimit = options.sampleLimit ?? 50;
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
    const sample = context.collected.get(SAMPLE_SIGNAL);
    if (sample == null || sample.status !== 'observed') {
      return unmeasurable(
        id,
        'The table sample was not collected, so there was nothing to describe. The sample comes from the ' +
          'system-table collector, which must run before this one. ' +
          (sample?.status === 'unmeasurable' ? `The sample reported: ${sample.unmeasurableReason ?? 'no reason.'}` : '')
      );
    }

    const selection = sample.value as SampleSelection;
    const candidates = selection.candidates.slice(0, this.sampleLimit);
    if (candidates.length === 0) {
      return unmeasurable(
        id,
        'No Delta tables were eligible to describe. Either the metastore holds none, or the scanning identity ' +
          'cannot see them. This is reported as unmeasured rather than as an estate with no layout problems.'
      );
    }

    const started = Date.now();
    const tables: TableDetail[] = [];
    const undescribed: { table: string; reason: string }[] = [];

    for (const candidate of candidates) {
      const name = `${candidate.catalog}.${candidate.schema}.${candidate.table}`;
      const quoted = quoteName(candidate);
      if (quoted == null) {
        undescribed.push({
          table: name,
          reason: 'A part of the table name is empty or contains a line break, so DESCRIBE DETAIL was not issued.',
        });
        continue;
      }
      const outcome = await context.scheduler.run({
        surface: 'describe',
        label: `describe:${name}`,
        run: async (signal) => {
          // Interpolated rather than bound, because DESCRIBE DETAIL takes an identifier
          // and identifiers cannot be parameters. The names come from
          // information_schema, not from user input, and are quoted per part so a name
          // needing quoting still resolves. See quoteName / quoteIdent.
          const raw = await this.options.executor(`DESCRIBE DETAIL ${quoted}`, {}, signal);
          this.calls += 1;
          const statementId = (raw as { statementId?: unknown }).statementId;
          if (typeof statementId === 'string') this.statementIds.push(statementId);
          return rowsOf(raw);
        },
      });

      if (outcome.status === 'ok') {
        const row = outcome.value[0];
        if (row != null) tables.push(detailOf(row, candidate));
        else undescribed.push({ table: name, reason: 'DESCRIBE DETAIL returned no rows.' });
        continue;
      }

      undescribed.push({
        table: name,
        reason: outcome.status === 'skipped' ? outcome.detail : outcome.failure.message,
      });

      // An exhausted budget or a cancellation applies to the whole surface, not to this
      // table, so every remaining table would be refused identically. Stopping keeps the
      // coverage count honest without spending the rest of the scan collecting the same
      // refusal N times. A permission denial is per-table, so that one carries on.
      if (outcome.status === 'skipped' && (outcome.reason === 'budget-exhausted' || outcome.reason === 'cancelled')) {
        break;
      }
    }

    if (tables.length === 0) {
      return unmeasurable(
        id,
        `None of the ${String(candidates.length)} sampled tables could be described. First reason: ` +
          `${undescribed[0]?.reason ?? 'unknown.'}`
      );
    }

    const value: TableDetails = { tables, eligibleTables: selection.eligibleTables, undescribed };
    // The coverage mode is the point of this collector: every control resolved from it
    // covers a stated subset, and a passing outcome must never read as estate-wide
    // compliance. Complete is claimed only when the sample reached the whole population.
    const complete = tables.length >= selection.eligibleTables;
    // Reach is inherited from the sample rather than declared, because this pass can only
    // describe tables the sample named. Defaulting to metastore when the sample did not
    // say keeps the claim no broader than information_schema, which is where it came from.
    const reach = sample.coverage.reach ?? 'metastore';
    return observed(
      id,
      value,
      Date.now() - started,
      complete
        ? { mode: 'complete', reach }
        : {
            mode: 'sampled',
            reach,
            examined: tables.length,
            population: selection.eligibleTables,
            basis:
              'the most-read tables first, by read events recorded in table lineage over the scan window, ' +
              'with a stable tiebreak by name so the same tables are covered on the next scan',
          }
    );
  }
}

function detailOf(row: Row, candidate: SampleSelection['candidates'][number]): TableDetail {
  return {
    catalog: candidate.catalog,
    schema: candidate.schema,
    table: candidate.table,
    sizeBytes: count(row, 'sizeInBytes'),
    fileCount: count(row, 'numFiles'),
    partitionColumns: jsonArray(row, 'partitionColumns'),
    clusteringColumns: jsonArray(row, 'clusteringColumns'),
    features: jsonArray(row, 'tableFeatures'),
    automaticClustering: (text(row, 'clusterByAuto') ?? '').toLowerCase() === 'true',
    properties: jsonMap(row, 'properties'),
    readEvents: candidate.readEvents,
  };
}

/**
 * A three-part name, each part quoted through the shared identifier rule.
 *
 * The parts come from `system.information_schema.tables` rather than from a request, so
 * this is not the last line of defence against injection — but it is not free of risk
 * either, because a table name may legitimately contain characters that break an
 * unquoted identifier. Backticks are doubled by `quoteIdent`, which is the escape
 * Databricks SQL uses, so a name containing one cannot terminate the quoting early.
 * Undefined when any part cannot be quoted, so the caller skips rather than emitting SQL.
 */
function quoteName(candidate: SampleSelection['candidates'][number]): string | undefined {
  const parts = [candidate.catalog, candidate.schema, candidate.table].map((part) => quoteIdent(part));
  if (parts.some((part) => part == null)) return undefined;
  return parts.join('.');
}
