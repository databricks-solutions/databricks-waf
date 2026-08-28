// Which scope names the Apps `user_api_scopes` registry accepts, asked rather than assumed.
//
// Live and optional, like its siblings: it needs a CLI profile, nothing in `npm run verify` runs it, and
// what it establishes is committed by hand into whichever document depends on it.
//
//   cd app && DATABRICKS_CONFIG_PROFILE=your-profile node scripts/measure-scope-registry.mjs [scope ...]
//
// ## Why this exists as a script
//
// ADR 0016 measured all 56 scopes the workspace publishes against this registry and recorded which nine it
// accepts. That table is the reason most of the security pillar is answered by attestation rather than by an
// API call, so it is load-bearing — and it was taken by hand, once, in August 2026. Every later question of
// the form "could the app read X" has to re-ask it for one name, and re-asking by hand is how a table goes
// stale without anyone noticing.
//
// `33h` asked it for the query-history endpoint and the answer decided the shape of the row: the registry
// accepts `sql.query-history:read`, so an install can request it, so plan retrieval is buildable. Had the
// name been refused the way `settings` and `clusters` are, the six plan rules could never fire in an Apps
// install and the row would have been a degradation path instead.
//
// ## What it proves, and what it does not
//
// **It proves the registry accepts a name.** Scope validation runs before the app lookup, so a name can be
// tested against an app that does not exist: a rejected name answers `INVALID_PARAMETER_VALUE` naming the
// scope, and an accepted one falls through to `NOT_FOUND` naming the app. Nothing is created or changed —
// the request patches an app that is not there.
//
// **It does not prove the minted token honours it.** ADR 0016 found `serving.serving-endpoints:read`
// validating at registration and granting nothing, the call refused for want of `model-serving` while the
// narrower scope was the one requested and effective. So acceptance here is necessary and not sufficient,
// and the other direction can only be measured from inside an install — which is what the `sql.query-history`
// family in `server/collect/rest/reach.ts` is for.
//
// ## Two controls, and why they are not decoration
//
// Every run probes a name known to be accepted and a name that cannot exist. Without them a registry that
// answered `NOT_FOUND` to everything — a changed error contract, a revoked token, a typo in the host —
// would report every candidate as accepted, which is the answer that unblocks work.
//
// The first version of this measurement had neither, and reported all twelve candidates rejected: its
// detector looked for the word "scope" in the response, and the app name it had invented to be absent was
// `waf-scope-probe-does-not-exist`. The apparatus matched itself. The name below has no such word in it, and
// the detector strips the probe's own name before reading the message.

import { execFileSync } from 'node:child_process';

const PROFILE = process.env.DATABRICKS_CONFIG_PROFILE?.trim() || 'labs';

/**
 * An app name that does not exist, and must not contain the word "scope".
 *
 * The response quotes it back, and a detector reading the message for "scope" reads this instead.
 */
const ABSENT_APP = 'waf-registry-probe-absent-app';

/** Rate limits are real here: the registry answered 429 to a burst of twelve. */
const GAP_MS = 1200;
const RETRIES = 6;

/**
 * The candidates, with the two controls first so a broken run is obvious before any answer is read.
 *
 * `sql.statement-execution` is accepted and in `app.yaml` today. The nonsense name cannot be accepted by any
 * registry. A run where those two agree is a run where the middle can be believed.
 */
const DEFAULT_CANDIDATES = [
  'sql.statement-execution',
  'not-a-real-package-at-all',
  'sql',
  'sql.query-history',
  'sql.query-history:read',
  'sql.history',
  'sql.history:read',
  'sql.queries',
  'sql.queries:read',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function host() {
  const raw = execFileSync('databricks', ['auth', 'env', '--profile', PROFILE], { encoding: 'utf8' });
  return String(JSON.parse(raw).env.DATABRICKS_HOST).replace(/\/+$/, '');
}

function token() {
  return JSON.parse(execFileSync('databricks', ['auth', 'token', '-p', PROFILE], { encoding: 'utf8' }))
    .access_token;
}

/**
 * Whether the registry accepted a scope name, from which failure it chose.
 *
 * `accepted` means validation passed and the request went on to look for an app that is not there.
 */
export function verdict(status, message, absentApp = ABSENT_APP) {
  const withoutOwnName = message.split(absentApp).join('<app>');
  if (/App with name .* does not exist|NOT_FOUND/i.test(withoutOwnName) && status === 404) return 'accepted';
  if (/not a valid scope|INVALID_PARAMETER_VALUE/i.test(withoutOwnName)) return 'rejected';
  return 'unclear';
}

async function probe(base, scope) {
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    const response = await fetch(`${base}/api/2.0/apps/${ABSENT_APP}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: ABSENT_APP, user_api_scopes: [scope] }),
    });
    const text = await response.text();
    if (response.status !== 429) return { status: response.status, text };
    await sleep(2000 * (attempt + 1));
  }
  return { status: 429, text: 'rate limited after every retry' };
}

async function main() {
  const candidates = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_CANDIDATES;
  const base = host();
  console.log(`registry: ${base}, probing an app that does not exist (${ABSENT_APP})\n`);

  const results = [];
  for (const scope of candidates) {
    const { status, text } = await probe(base, scope);
    const answer = verdict(status, text);
    results.push({ scope, status, verdict: answer });
    console.log(`  ${scope.padEnd(30)} ${String(status).padEnd(4)} ${answer}`);
    if (answer === 'unclear') console.log(`     ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
    await sleep(GAP_MS);
  }

  // The controls, checked after the fact so the report says whether to believe itself.
  const known = results.find((row) => row.scope === 'sql.statement-execution');
  const nonsense = results.find((row) => row.scope === 'not-a-real-package-at-all');
  if (known != null && nonsense != null) {
    const sound = known.verdict === 'accepted' && nonsense.verdict === 'rejected';
    console.log(
      `\ncontrols: a known scope reads ${known.verdict}, a nonsense one reads ${nonsense.verdict} — ${
        sound ? 'believe the rest' : 'DO NOT believe the rest'
      }`,
    );
    if (!sound) process.exitCode = 1;
  } else {
    console.log('\ncontrols: not probed, because the candidates were given on the command line');
  }
}

if (process.argv[1] != null && import.meta.filename === process.argv[1]) {
  await main();
}
