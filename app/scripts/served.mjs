// When the app was last served, and when the served app was last driven.
//
// Every measurement here that costs a workspace names its recording and has a check holding the prose
// to it — the runtime baseline, the read-path census, the history budget, the live Lakebase suite. The
// one verification that has repeatedly found defects no static check can see had none, so its staleness
// was invisible: the answer to "when did we last deploy to labs and drive the app?" had to be
// reconstructed from phase write-ups, came out as 2026-08-12, and eleven merged rows had gone behind it
// unverified. The deploy that closed that gap crashed the app within three minutes and found `88`, `89`
// and `90`. See docs/plan/87-nothing-records-when-the-app-was-last-served.md.
//
// Two facts, from two sources, and neither is asserted by hand:
//
//   served   what the platform says is running, read from `databricks apps get`. The deployment id and
//            its create time are the platform's, not ours.
//   driven   what drive-labs.mjs did, written by drive-labs.mjs at the end of a run, carrying the
//            deployment id it was driving.
//
// The deployment id in both halves is the join, and it is the reason this is not a date pair. Two dates
// say how old each fact is; the ids say whether the app serving now is the one anybody drove. A deploy
// after a drive is the exact situation that went unnoticed for five days, and it is invisible to dates
// alone unless a reader thinks to compare them.
//
// Nothing here is baked into the bundle. A commit or a build time compiled into the app would break
// check:bundle, which rebuilds the committed bundle and requires it to match byte for byte — so the
// app's identity has to come from outside the app, and the platform already holds it.
//
//   node scripts/served.mjs --serving          # ask the platform, write the `served` half
//   node scripts/served.mjs --check            # offline: hold the prose to the recording, report age
//   node scripts/served.mjs --publish          # offline: rewrite the prose from the recording

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const RECORDING = join(here, 'recordings/served.json');
const DOC = join(here, '../../docs/estates.md');

const START = '<!-- generated: when the app was last served, by scripts/served.mjs -->';
const END = '<!-- end generated -->';

/** The app the bundle declares, so this cannot drift from what a deploy produces. */
const APP = 'databricks-waf-assessment';

const read = () => (existsSync(RECORDING) ? JSON.parse(readFileSync(RECORDING, 'utf8')) : {});
const write = (recording) => writeFileSync(RECORDING, `${JSON.stringify(recording, null, 2)}\n`);

const WHAT =
  'When the app was last served, and when the served app was last driven in a browser. ' +
  'The `served` half is the platform\'s answer; the `driven` half is drive-labs.mjs\'s. ' +
  'The deployment ids say whether they are about the same app.';

/**
 * What the platform says is running.
 *
 * The profile is named rather than defaulted, and `--profile` alone is not enough: `DATABRICKS_HOST`
 * and friends in the environment beat it, so a good token goes to the wrong host and the CLI reports
 * both a valid profile and an invalid token. See docs/estates.md. The host that answered is recorded
 * so a reading taken against the wrong one can be recognised afterwards rather than believed.
 */
function serving(profile) {
  const said = execFileSync('databricks', ['apps', 'get', APP, '--profile', profile, '-o', 'json'], {
    encoding: 'utf8',
  });
  const app = JSON.parse(said);
  const deployment = app.active_deployment ?? {};

  if (deployment.deployment_id == null) {
    throw new Error(`${APP} on ${profile} reports no active deployment, so nothing is being served to record.`);
  }

  return {
    asked: new Date().toISOString(),
    estate: profile,
    app: APP,
    origin: app.url ?? '',
    deploymentId: deployment.deployment_id,
    deployedAt: deployment.create_time ?? '',
    deploymentState: deployment.status?.state ?? '',
    appState: app.app_status?.state ?? '',
    source: `databricks apps get ${APP} --profile ${profile}`,
  };
}

/**
 * What a drive of the served app did, written by drive-labs.mjs when it finishes.
 *
 * Refuses a local origin, and that refusal is the whole of the third thing `87` asked for. Browser work
 * continued for five days against a dev server pointed at labs data, which reads in a write-up exactly
 * like a drive of the deployed app and is not one: the served app is a bundle the platform installed,
 * bound to Postgres by the proxy, and both defects that deploy found were in that difference. A stamp
 * that a local run can write is a stamp that says nothing.
 *
 * The deployment id comes from the platform at drive time rather than from the recording, so a drive
 * cannot inherit the id of a deployment somebody else recorded.
 */
export function recordDriven({ origin, profile, drove, declared, failures, unreached }) {
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(origin)) {
    throw new Error(
      `${origin} is a dev server, not a served app, and this recording is only about the served app.\n` +
        'Point APP at the deployed origin — `databricks apps get databricks-waf-assessment -p labs -o json`\n' +
        'reports it as `url` — or run the drive without recording by setting WAF_NO_SERVED_STAMP=1.'
    );
  }

  /*
   * The origin driven has to be the origin served, and an origin the platform did not state cannot be
   * checked — so an app reporting no `url` is refused rather than accepted. Accepting it would write the
   * platform's deployment id beside an origin nothing had confirmed, which is a stamp that looks
   * confirmed and is not.
   *
   * Compared without a trailing slash on either side, because `drive-labs.mjs` strips one from `APP` and
   * the platform does not: the same origin written the two ways is the same origin, and throwing after a
   * completed drive over a slash would lose the run.
   */
  const now = serving(profile);
  const bare = (url) => url.replace(/\/$/, '');
  if (now.origin === '') {
    throw new Error(
      `${profile} reports no url for ${APP}, so nothing can confirm that ${origin} is what it serves.`
    );
  }
  if (bare(now.origin) !== bare(origin)) {
    throw new Error(
      `The drive was against ${origin} and ${profile} serves ${now.origin}. One of the two is not the app ` +
        'this recording is about, and guessing which would be the thing this file exists to prevent.'
    );
  }

  // Both halves are rewritten, because a drive establishes both: the platform was asked a moment ago
  // for the id being driven, and that answer is a fresher `served` than whatever was there.
  write({
    what: WHAT,
    served: now,
    driven: {
      at: new Date().toISOString(),
      estate: profile,
      origin,
      deploymentId: now.deploymentId,
      drove,
      declared,
      failures,
      ...(unreached.length > 0 ? { unreached } : {}),
    },
  });
}

/**
 * How long ago, in a unit that does not read as a contradiction.
 *
 * "0 days ago" beside a date a day earlier than the date it was asked on is arithmetic that a reader has
 * to redo before believing, so anything under two days is said in hours.
 */
export function ago(from, to) {
  const hours = Math.floor((Date.parse(to) - Date.parse(from)) / 3_600_000);
  if (hours < 1) return 'within the hour';
  if (hours < 48) return `${String(hours)} hours ago`;
  return `${String(Math.floor(hours / 24))} days ago`;
}

/**
 * Commits on this branch dated after the deploy.
 *
 * Not "commits the deploy does not have" — a commit authored before a deploy can merge after it, and
 * nothing in the recording could tell the difference. What this counts is what it says: how much has
 * landed since the app was last put up. `87`'s own evidence was this number reading eleven.
 */
function since(when) {
  try {
    const count = execFileSync('git', ['rev-list', '--count', `--since=${when}`, 'HEAD'], { encoding: 'utf8' });
    return Number(count.trim());
  } catch {
    return null;
  }
}

/**
 * The stamp as a reader meets it.
 *
 * Stated rather than judged. It reports the two dates, the two ids and whether they agree, and it does
 * not say whether that is acceptable — how old is too old before a pilot is a decision for
 * plan-status.md, and a sentence here that pre-empted it would be this file exceeding what it knows.
 *
 * Absolute facts only, and that constraint is not stylistic. Every relative one — how many hours ago,
 * how many commits have landed since — is true of the moment it is generated and false the next day, so
 * a document holding it drifts from its recording with nothing having changed, and the check guarding it
 * fails on the calendar. That is a check people learn to regenerate without reading, which is the
 * failure ADR 0027 records. The ages are what `--check` prints; the dates are what this states.
 */
export function stamp(recording) {
  const { served, driven } = recording;
  if (served == null) return `${START}\nNothing has recorded the app being served.\n${END}`;

  const lines = [
    `**Served:** \`${served.app}\` on ${served.estate}, deployed ${served.deployedAt.slice(0, 10)}, ` +
      `deployment \`${served.deploymentId.slice(0, 12)}\`, ` +
      `${served.appState.toLowerCase()} when asked on ${served.asked.slice(0, 10)}.`,
  ];

  if (driven == null) {
    lines.push('**Driven:** never. No browser has driven the served app since this was recorded.');
  } else {
    /*
     * "31 of 34 declared routes, all of them rendering" is the mistake AGENTS.md documents: `failures` is
     * a count of the routes the drive opened, and "all of them" reads across all thirty-four — including
     * three the drive never opened. A reader takes that as a verdict on the app and it is a verdict on
     * five sixths of it. The count is named, and the routes not driven are stated rather than left to
     * subtraction, because the gap is the part a reader would otherwise not know was there.
     */
    const missed = driven.declared - driven.drove;
    lines.push(
      `**Driven:** ${driven.at.slice(0, 10)}, ` +
        `${String(driven.drove)} of ${String(driven.declared)} declared routes, ` +
        `${driven.failures === 0 ? `none of those ${String(driven.drove)} failing to render` : `${String(driven.failures)} of them not rendering`}` +
        `${missed > 0 ? `. The other ${String(missed)} were not driven` : ''}.`
    );
    // Both sentences are about the two ids in the recording and say so. Neither may say what is serving
    // *now*: the `served` half was read when it was read, and the platform has been asked nothing since.
    lines.push(
      driven.deploymentId === served.deploymentId
        ? 'That drive was of the deployment this file last read as active.'
        : `The active deployment had changed by the time it was last read: the drive was of ` +
          `\`${driven.deploymentId.slice(0, 12)}\`, and \`${served.deploymentId.slice(0, 12)}\` was active on ` +
          `${served.asked.slice(0, 10)}.`
    );
  }

  return `${START}\n${lines.join('\n')}\n${END}`;
}

function replaced(doc, block) {
  const from = doc.indexOf(START);
  const to = doc.indexOf(END);
  if (from === -1 || to === -1) {
    throw new Error(`docs/estates.md has no generated block for this stamp. Add:\n\n${START}\n${END}\n`);
  }
  return `${doc.slice(0, from)}${block}${doc.slice(to + END.length)}`;
}

/*
 * The command line runs only when this file is the command, because `drive-labs.mjs` imports
 * `recordDriven` from it — and without this guard that import ran the default `--check` branch, which
 * failed on a stale document and exited before the browser opened. A module that does something when
 * it is imported is a module that cannot be imported.
 */
const invoked = process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

const mode = process.argv[2] ?? '--check';

if (!invoked) {
  // Imported for `recordDriven`; nothing to do.
} else if (mode === '--serving') {
  const profile = process.argv[3] ?? process.env.DATABRICKS_CONFIG_PROFILE ?? 'labs';
  const recording = read();
  write({ what: WHAT, served: serving(profile), ...(recording.driven == null ? {} : { driven: recording.driven }) });
  process.stdout.write(`Recorded what ${profile} is serving.\n`);
} else if (mode === '--publish' || mode === '--check') {
  if (!existsSync(RECORDING)) {
    process.stderr.write(
      'No recording of the app being served.\n' +
        '  node scripts/served.mjs --serving labs   asks the platform what is running\n' +
        '  APP=<origin> TOKEN=… node scripts/drive-labs.mjs   drives it and records the drive\n'
    );
    process.exit(1);
  }

  const recording = read();
  const doc = readFileSync(DOC, 'utf8');
  const updated = replaced(doc, stamp(recording));

  if (mode === '--publish') {
    writeFileSync(DOC, updated);
    process.stdout.write('Rewrote the served stamp in docs/estates.md.\n');
  } else {
    if (updated !== doc) {
      process.stderr.write(
        'The served stamp in docs/estates.md has drifted from its recording.\n' +
          'Run `node scripts/served.mjs --publish` and commit the result.\n'
      );
      process.exit(1);
    }

    // Reported, never failed on. A check that fails because a deploy is old is a check that fails on a
    // Monday morning for a reason nobody can fix in the pull request in front of them, and ADR 0027 is
    // what happens to a check people learn to work around. The age belongs in front of a release
    // decision, which is where the stamp above puts it.
    const { served, driven } = recording;
    const now = new Date().toISOString();
    const landed = since(served.deployedAt);
    process.stdout.write(
      `${served.app} on ${served.estate}: deployed ${ago(served.deployedAt, now)}, ` +
        `driven ${driven == null ? 'never' : ago(driven.at, now)}` +
        `${driven != null && driven.deploymentId !== served.deploymentId ? ', and redeployed since' : ''}` +
        `${landed == null ? '' : `. ${String(landed)} commits on this branch are dated after that deploy`}.\n`
    );
  }
} else {
  process.stderr.write(`Unknown mode ${mode}. Use --serving, --check or --publish.\n`);
  process.exit(2);
}
