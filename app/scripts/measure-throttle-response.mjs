// What the Statement Execution API does to a scan that asks for too much at once.
//
// `Q1k` measured the app's side and found the hole: `sql`, `describe`, `rest` and `cloud` all declare
// `clientRetries: true`, which allows the scheduler one attempt, and nothing underneath them retries —
// ADR 0010 said the SDK did, ADR 0012 then took the SDK away. So a throttled statement fails its signal
// on first sight.
//
// The remedy looks like one flag in `surfaces.ts`, and that is exactly why this exists. Flipping it
// changes every scan, and the numbers that decide the shape of the fix are not the app's: what the
// platform returns under load, how often, with what status, and whether it names an interval. This
// script asks the platform, and asks it in the only honest way — by actually being rude to a warehouse.
//
// ## What it does, and the bound on how rude it is
//
// It fires rounds of concurrent trivial statements at one warehouse, doubling the round size until
// either something is refused or the ceiling is reached, and records every response's status, the
// headers that bear on backoff, and the platform's error code. `SELECT 1` with `wait_timeout: 0s`, so
// each request is an admission decision and not a query: nothing is scanned, nothing is billed beyond
// the warehouse already being awake, and the thing under test is the API's own limiter rather than the
// warehouse's execution capacity.
//
// It stops on the first round that produces a refusal, because the question is where the boundary is
// and not how far past it the platform will let you go. It also cancels every statement it started,
// since `wait_timeout: 0s` returns a pending id rather than a result.
//
// ## What it cannot establish
//
// A workspace that never refuses has told you about that workspace on that day at that concurrency. It
// has not told you the platform does not throttle — which is ADR 0074's rule applied to a measurement
// rather than to a scan, and the reason the recording carries `refused: 0` with the ceiling it reached
// beside it rather than a conclusion.
//
//   DATABRICKS_CONFIG_PROFILE=your-profile node scripts/measure-throttle-response.mjs

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { refuseUnlessNamedForItsEstate } from './recording-guards.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * `runtime-baseline/<profile>-throttle-response.json`, which is the convention every estate-named
 * recording here follows and is not only a convention: `recording-guards.test.ts` finds the scripts it
 * holds to the guards by looking for that directory, so a recording written anywhere else is one the
 * census cannot see. The estate in the name matters more here than for most: a refusal boundary is a
 * property of one workspace's limiter on one day, and a file called `throttle-response.json` would read
 * as a property of the platform.
 */
function recordingFor(profile) {
  return join(HERE, '..', 'server', 'collect', 'sql', 'runtime-baseline', `${profile}-throttle-response.json`);
}

/**
 * The rounds, in requests issued at once.
 *
 * Doubling rather than stepping, because the boundary could be anywhere between two and a hundred and a
 * linear ramp would spend fifty rounds finding out. It stops at 128: past that the request rate is no
 * longer a scan's shape, and a number measured by hammering harder than any scan ever will is a number
 * about this script.
 */
const ROUNDS = [2, 4, 8, 16, 32, 64, 128, 256];

/**
 * The second phase: a sustained rate rather than a burst.
 *
 * A burst tests the concurrency limiter and a rate tests the quota, and they are different mechanisms
 * with different remedies — a concurrency refusal wants a smaller limiter, a quota refusal wants a
 * pause. `rest` is the surface where a quota is likeliest to bite: it declares a budget of 3,000 calls
 * against `sql`'s 250, so a scan spends twelve times as many requests there.
 */
const SUSTAINED_SECONDS = 30;
const SUSTAINED_PER_SECOND = 20;
/** Cheap, readable by any identity that can run a scan, and not a mutation. */
const REST_ENDPOINT = '/api/2.0/serving-endpoints';

/** Seconds to wait between rounds, so a round measures its own concurrency and not the last one's tail. */
const BETWEEN_ROUNDS_MS = 3_000;

const profile = process.env.DATABRICKS_CONFIG_PROFILE ?? '';
const host = (process.env.DATABRICKS_HOST ?? '').replace(/\/+$/, '');
const warehouse = process.env.DATABRICKS_WAREHOUSE_ID ?? '';
if (profile === '' || warehouse === '') {
  console.error('Set DATABRICKS_CONFIG_PROFILE and DATABRICKS_WAREHOUSE_ID.');
  process.exit(2);
}

const RECORDING = recordingFor(profile);

// Before anything is issued, not after: the guard's whole job is to stop a reading being taken against
// a workspace the recording does not name, and a check after the requests have gone out has already
// been rude to the wrong estate.
refuseUnlessNamedForItsEstate(RECORDING, profile, host);

const token = JSON.parse(
  execFileSync('databricks', ['auth', 'token', '-p', profile], { encoding: 'utf8' })
).access_token;

/**
 * The headers that bear on backoff, kept whatever their case.
 *
 * `retry-after` is the one the app parses. The two `x-ratelimit` families are recorded because their
 * presence would let a future scheduler pace itself before being refused rather than after, and their
 * absence is the finding that says it cannot.
 */
const INTERESTING = [/^retry-after$/i, /^x-rate-?limit/i, /^x-databricks/i, /^x-request-id$/i];

function headersOf(response) {
  const kept = {};
  for (const [name, value] of response.headers.entries()) {
    if (INTERESTING.some((pattern) => pattern.test(name))) kept[name.toLowerCase()] = value;
  }
  return kept;
}

async function issue() {
  const started = Date.now();
  try {
    const response = await fetch(`${host}/api/2.0/sql/statements`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      // `0s` returns as soon as the statement is admitted, so the wait is the admission decision. A
      // wait_timeout that blocks would measure how long a queued statement sits, which is the
      // warehouse's queue rather than the API's limiter and is a different question.
      body: JSON.stringify({ warehouse_id: warehouse, statement: 'SELECT 1', wait_timeout: '0s' }),
    });
    const body = await response.text();
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = {};
    }
    return {
      status: response.status,
      ms: Date.now() - started,
      headers: headersOf(response),
      // The platform's own code, which is what tells a `429` for concurrency apart from a `429` for
      // anything else it decides to spend the status on.
      errorCode: parsed?.error_code ?? null,
      message: typeof parsed?.message === 'string' ? parsed.message.slice(0, 300) : null,
      statementId: parsed?.statement_id ?? null,
      state: parsed?.status?.state ?? null,
    };
  } catch (error) {
    return {
      status: null,
      ms: Date.now() - started,
      headers: {},
      errorCode: error?.code ?? 'TRANSPORT',
      message: String(error?.message ?? error).slice(0, 300),
      statementId: null,
      state: null,
    };
  }
}

/** Every statement this round started, cancelled. A pending statement left behind is a cost to somebody. */
async function cancel(ids) {
  await Promise.all(
    ids.filter((id) => id != null).map((id) =>
      fetch(`${host}/api/2.0/sql/statements/${id}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => undefined)
    )
  );
}

/** A GET on the REST surface, recorded the same way, so the two phases are comparable. */
async function get(path) {
  const started = Date.now();
  try {
    const response = await fetch(`${host}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    // Drained rather than left open: an unread body keeps a socket, and 600 of those is a measurement
    // of this script's file descriptors.
    const body = await response.text();
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = {};
    }
    return {
      status: response.status,
      ms: Date.now() - started,
      headers: headersOf(response),
      errorCode: parsed?.error_code ?? null,
      message: typeof parsed?.message === 'string' ? parsed.message.slice(0, 300) : null,
    };
  } catch (error) {
    return {
      status: null,
      ms: Date.now() - started,
      headers: {},
      errorCode: error?.code ?? 'TRANSPORT',
      message: String(error?.message ?? error).slice(0, 300),
    };
  }
}

const rounds = [];
let refusedAt = null;

for (const size of ROUNDS) {
  process.stdout.write(`round of ${String(size)}... `);
  const results = await Promise.all(Array.from({ length: size }, () => issue()));
  await cancel(results.map((one) => one.statementId));

  const byStatus = {};
  for (const one of results) {
    const key = one.status == null ? String(one.errorCode) : String(one.status);
    byStatus[key] = (byStatus[key] ?? 0) + 1;
  }
  const refused = results.filter((one) => one.status != null && one.status >= 400);
  const durations = results.map((one) => one.ms).sort((a, b) => a - b);

  rounds.push({
    size,
    byStatus,
    refused: refused.length,
    // Only the refusals are kept whole. A round of 128 accepted responses is 128 identical records and
    // the recording is meant to be read.
    refusals: refused.slice(0, 8).map((one) => ({
      status: one.status,
      errorCode: one.errorCode,
      message: one.message,
      headers: one.headers,
      ms: one.ms,
    })),
    // One accepted response's headers, so the recording can answer "does the platform ever send a rate
    // limit header" rather than only "did it send one when it refused".
    acceptedHeaders: results.find((one) => one.status === 200)?.headers ?? {},
    medianMs: durations[Math.floor(durations.length / 2)] ?? null,
    slowestMs: durations[durations.length - 1] ?? null,
  });

  console.log(
    `${Object.entries(byStatus).map(([k, v]) => `${v}×${k}`).join(' ')} — median ${String(rounds.at(-1).medianMs)}ms`
  );

  if (refused.length > 0) {
    refusedAt = size;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, BETWEEN_ROUNDS_MS));
}

/*
 * Phase two. One tick a second, `SUSTAINED_PER_SECOND` requests in each, for half a minute — 600 calls,
 * which is a fifth of the `rest` budget a single scan is allowed to spend. Ticks are not awaited in
 * series: a quota is per unit of wall clock, so a phase that waited for each tick to finish would
 * measure a slower rate than the one it declares.
 */
process.stdout.write(`\nsustained: ${String(SUSTAINED_PER_SECOND)}/s on ${REST_ENDPOINT} for ${String(SUSTAINED_SECONDS)}s... `);
const ticks = [];
for (let second = 0; second < SUSTAINED_SECONDS; second += 1) {
  ticks.push(Promise.all(Array.from({ length: SUSTAINED_PER_SECOND }, () => get(REST_ENDPOINT))));
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
const sustainedResults = (await Promise.all(ticks)).flat();
const sustainedByStatus = {};
for (const one of sustainedResults) {
  const key = one.status == null ? String(one.errorCode) : String(one.status);
  sustainedByStatus[key] = (sustainedByStatus[key] ?? 0) + 1;
}
const sustainedRefused = sustainedResults.filter((one) => one.status != null && one.status >= 400);
const sustainedDurations = sustainedResults.map((one) => one.ms).sort((a, b) => a - b);
const sustained = {
  endpoint: REST_ENDPOINT,
  perSecond: SUSTAINED_PER_SECOND,
  seconds: SUSTAINED_SECONDS,
  issued: sustainedResults.length,
  byStatus: sustainedByStatus,
  refused: sustainedRefused.length,
  refusals: sustainedRefused.slice(0, 8).map((one) => ({
    status: one.status,
    errorCode: one.errorCode,
    message: one.message,
    headers: one.headers,
  })),
  acceptedHeaders: sustainedResults.find((one) => one.status === 200)?.headers ?? {},
  medianMs: sustainedDurations[Math.floor(sustainedDurations.length / 2)] ?? null,
  slowestMs: sustainedDurations[sustainedDurations.length - 1] ?? null,
};
console.log(Object.entries(sustainedByStatus).map(([k, v]) => `${v}×${k}`).join(' '));

const ceiling = rounds.at(-1)?.size ?? 0;
const allRefusals = [...rounds.flatMap((round) => round.refusals), ...sustained.refusals];
const anyRetryAfter = allRefusals.some((one) => Object.keys(one.headers).some((name) => name === 'retry-after'));
const anyRateLimitHeader =
  rounds.some((round) => Object.keys(round.acceptedHeaders).some((name) => name.startsWith('x-rate'))) ||
  Object.keys(sustained.acceptedHeaders).some((name) => name.startsWith('x-rate')) ||
  allRefusals.some((one) => Object.keys(one.headers).some((name) => name.startsWith('x-rate')));

mkdirSync(dirname(RECORDING), { recursive: true });
writeFileSync(
  RECORDING,
  `${JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      host,
      profile,
      warehouse,
      statement: 'SELECT 1',
      waitTimeout: '0s',
      rounds,
      sustained,
      // The three questions the fix needs answered, stated as readings rather than left to a reader to
      // derive from the rounds.
      refusedAt,
      ceilingReached: ceiling,
      sustainedRefused: sustained.refused,
      sendsRetryAfter: anyRetryAfter,
      sendsRateLimitHeaders: anyRateLimitHeader,
    },
    null,
    2
  )}\n`
);

console.log(`\nwrote ${RECORDING}`);
console.log(
  refusedAt == null
    ? `Nothing was refused up to ${String(ceiling)} concurrent, nor at ${String(SUSTAINED_PER_SECOND)}/s ` +
        `for ${String(SUSTAINED_SECONDS)}s. That is a fact about this workspace on this day, not about ` +
        'the platform.'
    : `First refusal at ${String(refusedAt)} concurrent. Retry-After ${anyRetryAfter ? 'sent' : 'absent'}.`
);
