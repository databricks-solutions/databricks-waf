/*
 * How much plan reach moves between runs of an estate that has not changed. Row `33o`.
 *
 * `plan-capability.ts` reports two transitions and deliberately no proportional one, because a rule of
 * the form "alert when reach drops by more than a fifth" needs to know what an untroubled run does and
 * nobody had watched two. This is that watching. What it produces decides `33p`: a distribution narrow
 * enough to put a threshold under, or a finding that there is not one, which closes the pair.
 *
 * Live and optional, like the other `measure-` scripts: it needs a warehouse and a CLI profile, nothing
 * in `npm run verify` runs it, and what it writes is committed by hand.
 *
 *   cd app && DATABRICKS_WAREHOUSE_ID=<id> DATABRICKS_CONFIG_PROFILE=your-profile \
 *     npx tsx scripts/measure-plan-reach-variation.mts
 *
 * ## What it measures with, and why that matters here
 *
 * The real `retrievePlans` and the real `summarise`, through the real scheduler, rather than a
 * reimplementation of the skip rules. `33p`'s threshold would be read against `summarise()`'s four
 * numbers, so a measurement of anything else is a measurement of a statement that does not exist —
 * which is the mistake `H1` made and a reviewer caught. `plan-corpus.mjs` has its own `eachPlan()` with
 * its own copy of the skip logic; it is not used here for that reason.
 *
 * The one thing it does not share with a scan is the shape statement's binding. `runShapes()` passes an
 * empty `live_workspace_ids`, which is `collector.ts`'s degraded binding: with no workspace directory it
 * reads every workspace on the metastore rather than the live set. That widens the corpus, and it is why
 * some shapes come back on a warehouse this workspace cannot see — recorded as `skipped`, exactly as a
 * scan would record them if it saw them.
 *
 * ## What it cannot measure, and this is the limit to read the recording against
 *
 * **These runs are minutes apart and a scan's are a week apart.** The variation this can see is the part
 * that comes from the platform answering differently right now: a statement ageing out of query history
 * between two reads, a fetch that fails once, a shape whose representative changes. The part that comes
 * from a week of the estate doing different work is invisible to it, and that part is not small. So a
 * distribution measured here is a **lower bound** on what a weekly alert would see, and a threshold set
 * from it would fire more often than the recording implies rather than less. Whatever this says, it
 * cannot say a threshold is safe — only that one is not.
 *
 * The interval between runs is recorded per run so the reading can be re-taken over a longer span
 * without the two being confused for each other.
 *
 * **And on labs the quantity does not move at all, because reach there is total.** Nine runs measured
 * `withoutPlan` 0 and `failed` 0 every time, so 34 of 34 asked came back with a plan. A denominator that
 * is never short cannot show how short it gets. That is a property of the estate rather than of this
 * script, and it is the second reason the labs recording cannot put a threshold under `33p` — but it is
 * worth knowing before spending another hour and a half here rather than somewhere with churn in it.
 *
 * ## It writes after every run, on purpose
 *
 * `61b` lost two thirds of a three-hour reading to a script that wrote its recording once at the end
 * and was killed before it got there. A measurement whose whole design is "wait a long time between
 * readings" is the worst possible place to repeat that, so the file is rewritten as each run lands and
 * says how many of the runs it asked for it holds. An interrupted sweep is a shorter sweep.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CollectionScheduler } from '../server/scan/scheduler.js';
import { parse } from '../server/collect/sql/shapes.js';
import { PlanFetcher } from '../server/collect/sql/plans/fetch.js';
import { retrievePlans, summarise, type PlanRetrievalSummary } from '../server/collect/sql/plans/retrieve.js';
import { corpusSettings, runShapes } from './plan-corpus.mjs';
import { refuseUnlessNamedForItsEstate } from './recording-guards.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'server', 'collect', 'sql', 'runtime-baseline');

const RUNS = Number(process.env.REACH_RUNS ?? 6);
/** Long enough that two runs are not one read of the same cache, short enough to finish in an evening. */
const GAP_MS = Number(process.env.REACH_GAP_MS ?? 60_000);

const { profile, host, warehouse } = corpusSettings;
if (!host) throw new Error('DATABRICKS_HOST is required');
if (!warehouse) throw new Error('DATABRICKS_WAREHOUSE_ID is required');

const path = join(OUT, `${profile}-plan-reach-variation.json`);
refuseUnlessNamedForItsEstate(path, profile, host);

function token(): string {
  const issued = execFileSync('databricks', ['auth', 'token', '-p', profile], { encoding: 'utf8' });
  return (JSON.parse(issued) as { access_token: string }).access_token;
}

/** The warehouses this workspace can see, which is what decides whether a shape is worth asking about. */
async function localWarehouseIds(): Promise<Set<string>> {
  const response = await fetch(`${host}/api/2.0/sql/warehouses`, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  if (!response.ok) throw new Error(`the warehouse list came back ${String(response.status)}`);
  const body = (await response.json()) as { warehouses?: { id?: string }[] };
  return new Set((body.warehouses ?? []).map((one) => one.id).filter((id): id is string => id != null));
}

/** How many shapes a request was actually issued for — `plan-capability.ts`'s own definition. */
const asked = (plans: PlanRetrievalSummary) => plans.available + plans.withoutPlan + plans.failed;

interface Reading {
  readonly at: string;
  readonly sincePreviousMs: number | null;
  readonly shapes: number;
  readonly available: number;
  readonly withoutPlan: number;
  readonly failed: number;
  readonly abandoned: number;
  readonly notRun: number;
  readonly asked: number;
  readonly skipped: Readonly<Partial<Record<string, number>>>;
  readonly warehousesKnown: boolean;
  /** Shapes in this run that were not in the one before it, and the reverse. Null on the first run. */
  readonly shapesEntering: number | null;
  readonly shapesLeaving: number | null;
}

const readings: Reading[] = [];
let previousAt: number | null = null;
let previousShapes: Set<string> | null = null;

/** Spread of one field across the runs so far, which is the whole product of this script. */
function spread(field: (one: Reading) => number) {
  const values = readings.map(field);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const mean = values.reduce((sum, one) => sum + one, 0) / values.length;
  return {
    low,
    high,
    mean: Number(mean.toFixed(2)),
    // As a share of the mean, because a threshold is proportional and an absolute swing of three means
    // different things at four shapes and at forty.
    spreadOfMean: mean === 0 ? null : Number(((high - low) / mean).toFixed(4)),
  };
}

function record() {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        what: "Run-to-run variation in plan reach on an unchanged estate, for 33o's threshold question.",
        profile,
        host,
        warehouse,
        lookbackDays: corpusSettings.lookbackDays,
        shapeLimit: corpusSettings.shapeLimit,
        takenAt: new Date().toISOString(),
        runsAsked: RUNS,
        runsHeld: readings.length,
        gapMs: GAP_MS,
        limit:
          'These runs are minutes apart and a scan is weekly, so this is a lower bound on what a weekly ' +
          'alert would see. It can show a threshold is unsafe and cannot show one is safe.',
        spread: {
          shapes: spread((one) => one.shapes),
          available: spread((one) => one.available),
          withoutPlan: spread((one) => one.withoutPlan),
          failed: spread((one) => one.failed),
          asked: spread((one) => one.asked),
        },
        readings,
      },
      null,
      2
    )}\n`
  );
}

for (let run = 0; run < RUNS; run += 1) {
  if (run > 0) await new Promise((resolve) => setTimeout(resolve, GAP_MS));

  const at = Date.now();
  const rows = parse.queryShapes(await runShapes());
  const retrieval = await retrievePlans({
    shapes: rows,
    localWarehouseIds: await localWarehouseIds(),
    warehousesKnown: true,
    fetcher: new PlanFetcher({ host, token: () => Promise.resolve(token()) }),
    scheduler: new CollectionScheduler({}),
  });

  const plans = summarise(retrieval);
  const shapes = new Set(rows.map((row) => row.shape));
  const before = previousShapes;
  const entering = before == null ? null : [...shapes].filter((one) => !before.has(one)).length;
  const leaving = before == null ? null : [...before].filter((one) => !shapes.has(one)).length;

  readings.push({
    at: new Date(at).toISOString(),
    sincePreviousMs: previousAt == null ? null : at - previousAt,
    shapes: rows.length,
    available: plans.available,
    withoutPlan: plans.withoutPlan,
    failed: plans.failed,
    abandoned: plans.abandoned,
    notRun: plans.notRun,
    asked: asked(plans),
    skipped: plans.skipped,
    warehousesKnown: plans.warehousesKnown,
    shapesEntering: entering,
    shapesLeaving: leaving,
  });

  previousAt = at;
  previousShapes = shapes;
  record();

  const last = readings.at(-1);
  console.log(
    `run ${String(run + 1)}/${String(RUNS)}: ${String(last?.shapes)} shapes, ` +
      `available ${String(last?.available)}, withoutPlan ${String(last?.withoutPlan)}, ` +
      `failed ${String(last?.failed)}, asked ${String(last?.asked)}`
  );
}

console.log(`\nwrote ${path}`);
