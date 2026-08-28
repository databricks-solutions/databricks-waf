// Does a reader who did not press the button learn that a run is happening?
//
// This is the exact case the app was blind to, and it cannot be tested anywhere else. A component
// test can assert the band renders from a prop; only a real browser against the deployed app can
// show that the browser finds out at all — that a page sitting idle notices a run started somewhere
// else, follows it, and picks up its result without being reloaded.
//
// The run is started over HTTP rather than by clicking, deliberately: clicking would set the local
// state that used to be the only signal, and prove nothing.
//
//   TOKEN=$(databricks auth token -p labs | jq -r .access_token) \
//   APP=https://<app>.databricksapps.com node scripts/drive-run-notice.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { open, settle } from './browser.mjs';

const origin = (process.env.APP ?? '').replace(/\/$/, '');
const token = process.env.TOKEN ?? '';
if (origin === '' || token === '') {
  console.error('Set APP to the deployed origin and TOKEN to a workspace token.');
  process.exit(2);
}

/** Where the reader is standing. Not the overview, which is the page the old band was on. */
const WATCHING_FROM = process.env.FROM ?? '/findings';

const shots = '.tmp-shots/run-notice';
mkdirSync(shots, { recursive: true });

const failures = [];
const note = (ok, what) => {
  console.log(`${ok ? '✓' : '✗'} ${what}`);
  if (!ok) failures.push(what);
};

/** What the band on screen says, or null when there is no band. */
const READ_BAND = `(() => {
  const band = document.querySelector('.wa-callout');
  const live = document.querySelector('[aria-live="polite"]');
  return JSON.stringify({
    band: band == null ? null : band.innerText.replace(/\\s+/g, ' ').trim(),
    live: live == null ? null : live.innerText.trim(),
    chip: document.querySelector('[data-status]')?.innerText.trim() ?? null,
    runId: (document.body.innerText.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) ?? [null])[0],
    measured: (document.body.innerText.match(/Measured [^·\\n]+/) ?? [null])[0],
  });
})()`;

const page = await open({ width: 1512, height: 945 });
await page.send('Network.enable');
await page.send('Network.setExtraHTTPHeaders', { headers: { Authorization: `Bearer ${token}` } });

await page.goto(`${origin}${WATCHING_FROM}`);
await settle(1500);

const atRest = JSON.parse(await page.evaluate(READ_BAND));
note(atRest.band == null, 'says nothing about a run while nothing is running');
console.log(`  at rest: chip=${atRest.chip ?? '-'} measured=${(atRest.measured ?? '-').slice(0, 60)}`);
const wasMeasured = atRest.measured;

/*
 * Started from here rather than in the page, so the page has no local state saying a run began.
 *
 * Deliberately not awaited. The scan route holds its response open for the whole run, so awaiting it
 * would mean the watching below did not begin until the run had already finished — which is how the
 * first version of this script "passed" every check about a band that never appeared.
 */
void fetch(`${origin}/api/scan`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({}),
}).catch(() => undefined);
console.log('\n  run requested over HTTP, the page was not told\n');

/** Polls the browser until `enough` is satisfied, so a slow answer is a timeout and not a wrong assertion. */
async function until(enough, seconds, label) {
  const deadline = Date.now() + seconds * 1000;
  let last = null;
  while (Date.now() < deadline) {
    last = JSON.parse(await page.evaluate(READ_BAND));
    if (enough(last)) return last;
    await settle(1000);
  }
  console.log(`  timed out after ${String(seconds)}s waiting for ${label}`);
  return last;
}

// The idle poll is fifteen seconds, so this is the worst case plus room for the request.
const noticed = await until((state) => state.band != null, 25, 'the band to appear');
note(noticed?.band != null, 'notices a run it did not start, without being reloaded');
if (noticed?.band != null) console.log(`  band: ${noticed.band}`);
writeFileSync(`${shots}/noticed.png`, await page.screenshot());

if (noticed?.band != null) {
  note(/measuring your estate/i.test(noticed.band), 'says what is happening in words');
  note(/Running for \d/.test(noticed.band), 'shows a clock');
  note(!/%/.test(noticed.band), 'shows no percentage, because there is no honest denominator');
  note(noticed.chip === 'Scanning', `the header chip reads as scanning (it read "${noticed.chip ?? '-'}")`);

  // The clock has to move, or it is a screenshot of a clock.
  const first = /Running for ([^ ]+)/.exec(noticed.band)?.[1];
  await settle(3000);
  const later = JSON.parse(await page.evaluate(READ_BAND));
  const second = /Running for ([^ ]+)/.exec(later.band ?? '')?.[1];
  note(first !== second, `the clock ticks (${first ?? '-'} then ${second ?? '-'})`);

  // And the count of calls has to be the run's, not a fixture.
  const counted = await until((state) => /\d[\d,]* quer/.test(state.band ?? ''), 90, 'the call count to appear');
  note(/\d[\d,]* quer/.test(counted?.band ?? ''), 'counts the calls the run has made');
  if (counted?.band != null) console.log(`  band: ${counted.band}`);
  writeFileSync(`${shots}/counting.png`, await page.screenshot());
}

// The other half of the defect: the reader must end up looking at the new run, not the old one.
const finished = await until((state) => state.band == null, 360, 'the run to finish');
note(finished?.band == null, 'clears the band when the run ends');
await settle(2000);

const after = JSON.parse(await page.evaluate(READ_BAND));
note(
  after.measured != null && after.measured !== wasMeasured,
  `picks up the finished run without a reload (was "${(wasMeasured ?? '-').slice(0, 40)}", now "${(after.measured ?? '-').slice(0, 40)}")`
);
writeFileSync(`${shots}/picked-up.png`, await page.screenshot());

page.close();

console.log(`\nScreenshots in ${shots}`);
if (failures.length > 0) {
  console.error(`\n${String(failures.length)} checks failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('A reader who did not start the run is told about it, and ends up reading its result.');
