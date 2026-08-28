// The five serving statements, executed.
//
// A separate module from the route for one reason: the route decides who may ask and what the answer
// looks like, and this decides what is bound to `:serving_names` and friends. Binding is the half that
// can be wrong in a way nobody sees — a limit bound to one statement and not the next reports six
// dimensions over a set of assets that is not the set the surface names — so it is written once, here,
// with the five calls sharing the number rather than each carrying their own.
//
// Five rather than three since row 65: the quality and classification reads left the facts statement
// because their system schemas are enabled per metastore and absent by default, and an absent schema
// fails a statement at parse time rather than returning nothing. ADR 0088.
//
// Not the `SqlCollector`. The collector schedules against a per-surface budget and records a signal
// per statement, which is what a scan needs and is the wrong shape for a page: they run in two passes
// with the second bound to the first's answer, and four of them do not run at all on an install that
// has declared nothing. The statement text and the parameter names are still the shipped
// ones, read off `config/statements` through the same source, so a statement edited for a scan is the
// statement this runs.

import { sql } from '@databricks/appkit';
import type { SqlExecutor } from '../collect/sql/collector.js';
import { rowsOf, SERVING_LIMIT } from '../collect/sql/collector.js';
import { FileQuerySource, type QuerySource } from '../collect/sql/queries.js';
import { parse } from '../collect/sql/shapes.js';
import type { ServingSql } from './readiness-read.js';

export interface ServingSqlOptions {
  readonly executor: SqlExecutor;
  /** The window the lineage and quality halves of the facts read are over. */
  readonly lookbackDays: number;
  readonly queries?: QuerySource;
  /** The shared row ceiling. One number over three statements, deliberately — see `SERVING_LIMIT`. */
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export function servingSql(options: ServingSqlOptions): ServingSql {
  const queries = options.queries ?? new FileQuerySource();
  const limit = sql.int(options.limit ?? SERVING_LIMIT);
  const run = async (name: string, parameters: Parameters<SqlExecutor>[1]) =>
    rowsOf(await options.executor(queries.text(name), parameters, options.signal));

  return {
    population: async (names, tagKeys) =>
      parse.servingPopulation(
        await run('serving_population', {
          serving_names: sql.string(names),
          serving_tag_keys: sql.string(tagKeys),
          serving_limit: limit,
        }),
      ),

    tags: async (assets) =>
      parse.servingTags(
        await run('serving_asset_tags', { serving_assets: sql.string(assets), serving_limit: limit }),
      ),

    facts: async (assets) =>
      parse.servingFacts(
        await run('serving_asset_facts', {
          serving_assets: sql.string(assets),
          serving_limit: limit,
          lookback_days: sql.int(options.lookbackDays),
        }),
      ),

    quality: async (assets) =>
      parse.servingQuality(
        await run('serving_asset_quality', {
          serving_assets: sql.string(assets),
          serving_limit: limit,
          lookback_days: sql.int(options.lookbackDays),
        }),
      ),

    classes: async (assets) =>
      parse.servingClasses(
        await run('serving_asset_classifications', {
          serving_assets: sql.string(assets),
          serving_limit: limit,
        }),
      ),
  };
}
