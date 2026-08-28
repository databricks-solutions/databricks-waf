// Drives the deployed app in a real browser, against a real workspace, and reports what is on screen.
//
// The static checks and the unit tests both measure the app as it is built. This measures the app as
// it is served: the bundle the platform installed, the Postgres it was bound to, and the scan a real
// workspace produced. It exists because the two have differed — a page that renders from a fixture in
// a test renders from a payload here, and a payload that a route composed on a laptop is composed by
// the deployed process against the real catalogue.
//
// Identity is forwarded as a bearer token, which is what the Apps proxy accepts in front of a request
// that did not come from a browser session. The reader in the app is then the token's owner.
//
//   TOKEN=$(databricks auth token -p labs | jq -r .access_token) \
//   APP=https://<app>.databricksapps.com node scripts/drive-labs.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { open, settle } from './browser.mjs';
import { customerHierarchyProblems } from './customer-hierarchy.mjs';
import { internalDeliveryLabels } from './customer-language.mjs';
import {
  isParameterised,
  productionRoutes,
  routePattern,
  routeScreenshotName,
  routerSource,
  screenshotNameProblems,
} from './routes.mjs';
import { RENDERED_SURFACE_SELECTOR } from './served-page.mjs';
import { recordDriven } from './served.mjs';

const origin = (process.env.APP ?? '').replace(/\/$/, '');
const token = process.env.TOKEN ?? '';
if (origin === '' || token === '') {
  console.error('Set APP to the deployed origin and TOKEN to a workspace token.');
  process.exit(2);
}

/*
 * The pages a reader can open, taken from the route table rather than from memory.
 *
 * This was a hand-maintained array of eighteen paths against a router that declares thirty, and the
 * gap was invisible from the output: the sweep signed off with "every page rendered", which was true
 * of the pages it opened and silent about `/start`, `/warehouses` and `/jobs`. `/jobs` arrived with
 * `33cd` and nobody edited the array, so the one check that measures the app as it is *served* had
 * never once loaded it. Reading the table means a new route is driven the day it is declared, and a
 * route that cannot be is named below with the reason.
 */
const declared = productionRoutes(routerSource());
const screenshotProblems = screenshotNameProblems(declared.map(({ path }) => path));
if (screenshotProblems.length > 0) {
  throw new Error(`Production routes collide in the screenshot record:\n${screenshotProblems.join('\n')}`);
}

/** A path no route serves, which is the only way to reach the catch-all. */
const MISSING = '/no-such-page';

const PAGES = declared.filter(({ path }) => !isParameterised(path) && path !== '*').map(({ path }) => path);

const shots = '.tmp-shots/labs';
mkdirSync(shots, { recursive: true });

/*
 * Screenshots are diagnostics, so a lost one is noted and the sweep continues.
 *
 * This threw, and a capture that Chrome declined to answer ended the run on the first page — losing the
 * verdict on the fourteen pages after it, which is the thing the sweep exists to produce. The picture
 * makes a failure easier to look at afterwards; it is not the finding.
 */
const shot = async (name) => {
  try {
    writeFileSync(`${shots}/${name}.png`, await page.screenshot());
  } catch (cause) {
    console.log(`    (no screenshot: ${cause instanceof Error ? cause.message : String(cause)})`);
  }
};

const page = await open({ width: 1512, height: 945 });

/*
 * Every request the page makes, including its own API calls, carries the reader's identity — in all
 * three forms, because which one is read depends on what is in front of the app.
 *
 * The deployed app sits behind the Apps proxy, which accepts `Authorization: Bearer` from a caller
 * that is not a browser session and rewrites it into the forwarded headers. A server run locally
 * against the same workspace has no proxy, so it reads the forwarded headers directly. Sending only
 * the bearer drove the local server as nobody at all: every page rendered its refusal, which fits
 * any window and has a heading, so this script reported on pages it never saw.
 */
await page.send('Network.enable');
await page.send('Network.setExtraHTTPHeaders', {
  headers: {
    Authorization: `Bearer ${token}`,
    'x-forwarded-access-token': token,
    ...(process.env.EMAIL != null && process.env.EMAIL !== '' ? { 'x-forwarded-email': process.env.EMAIL } : {}),
  },
});

/*
 * Whether the app knows who this is, asked before fourteen pages are judged.
 *
 * A sweep run with an EMAIL that is not the token's owner drove the whole app as a stranger: every page
 * still rendered, because reading is open to any authenticated reader, and every route behind group
 * membership refused. The report was fifteen ticks and the audit trail afterwards held three
 * `membership-unknown` refusals nobody had asked for — the app behaving correctly, the sweep measuring
 * something other than what it claimed to.
 *
 * A route that needs membership is the cheapest way to ask. Its refusal is a fact about the run, so it
 * is reported and the sweep continues: an install where nobody is a member is a real install, and its
 * pages are still worth a verdict.
 */
const gated = await fetch(`${origin}/api/definitions/drafts`, {
  headers: {
    Authorization: `Bearer ${token}`,
    'x-forwarded-access-token': token,
    ...(process.env.EMAIL != null && process.env.EMAIL !== '' ? { 'x-forwarded-email': process.env.EMAIL } : {}),
  },
});
if (gated.ok) {
  console.log(`Driving as ${process.env.EMAIL ?? "the token's owner"}, who this app accepts.\n`);
} else {
  const said = await gated.text();
  console.log(
    `Driving as ${process.env.EMAIL ?? "the token's owner"}, whom this app refuses (${String(gated.status)}: ` +
      `${said.slice(0, 120)}).\nRead-only pages are still measured below; anything behind group membership is not.\n`
  );
}

const failures = [];

/** Every in-app href the sweep has seen, which is where an instance of a parameterised route comes from. */
const seenLinks = new Set();

/**
 * Opens one path and reports what came back.
 *
 * `expects` is copy this page must carry *in addition* to rendering something, for a page where
 * rendering something is not enough to say the right page arrived. The catch-all is the case: it is
 * reached by a path no route serves, so "a panel appeared" is equally true of the page it is supposed
 * to show and of any page it might have fallen through to.
 */
const visit = async (path, { shotName, expects } = {}) => {
  await page.goto(`${origin}${path}`);
  await settle(600);

  const seen = await page.evaluate(`(() => {
    const text = document.body.innerText;
    const surfaces = document.querySelectorAll(${JSON.stringify(RENDERED_SURFACE_SELECTOR)}).length;
    const empty = document.querySelectorAll('.wa-empty').length;
    const primaryActionLabels = [...document.querySelectorAll('#run-controls .wa-button-primary, main .wa-button-primary')]
      .map((node) => node.innerText.trim())
      .filter((label) => label !== '');
    // Anything the app itself renders as a refusal, which is the failure mode a screenshot hides.
    const refusals = [...document.querySelectorAll('.wa-error, [role="alert"]')].map((n) => n.innerText.trim());
    const headings = [...document.querySelectorAll('main h1, main h2, main h3')]
      .map((node) => node.innerText.trim())
      .filter((text) => text !== '');
    const recommendations = [...document.querySelectorAll('[data-customer-action="recommendation"]')].map((node) => {
      const box = node.getBoundingClientRect();
      const support = node.parentElement?.querySelector('dl, table, pre, [data-technical-evidence]');
      return {
        text: node.innerText,
        destinationCount: node.querySelectorAll('a[href], button').length,
        beforeSupport: support == null || box.top <= support.getBoundingClientRect().top,
        inFirstViewport: box.top < window.innerHeight,
      };
    });
    const numbers = text.match(/\\b\\d[\\d,.]*%?\\b/g) ?? [];
    return JSON.stringify({
      title: document.title,
      heading: document.querySelector('h1, h2')?.innerText ?? '', headings,
      surfaces, empty, refusals, primaryActionLabels,
      recommendations,
      numbers: numbers.slice(0, 8),
      chars: text.length,
      text,
      links: [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')),
    });
  })()`);
  const state = JSON.parse(seen);

  for (const href of state.links) if (href != null && href.startsWith('/')) seenLinks.add(href);

  await shot(shotName ?? routeScreenshotName(path));

  /*
   * React Router's own error boundary, which is what a page looks like when its component throws.
   *
   * It replaces the whole application — shell, rail and all — with "Unexpected Application Error!" and
   * a stack, so the panel count below already catches it. Naming it separately is what makes the
   * output say which failure this is: a crash and an empty page read identically as "no panel", and
   * the two are fixed in entirely different places.
   */
  if (/Unexpected Application Error/i.test(state.text)) {
    failures.push(`${path} crashed: React Router rendered its error boundary in place of the app`);
  } else {
    if (state.surfaces === 0 && state.empty === 0) failures.push(`${path} rendered neither a customer surface nor an empty state`);
    if (expects != null && !expects.test(state.text))
      failures.push(`${path} rendered, but not the page it is served by`);
  }

  /*
   * A warning about durability is not a refusal, and reporting it as one made the sweep useless.
   *
   * Seven of fifteen pages "did not render" on a run where all fifteen did, because a server started
   * with WAF_DEMO_NO_PERSISTENCE tells every page that writes something that the write will not
   * survive a deploy — correctly, at length, in an element with role="alert". A check that fails on
   * the app behaving as designed is a check its reader learns to skip, which is worse than not having
   * it: the refusals it was written to catch were in the same list as the noise.
   */
  const stopped = state.refusals.filter((text) => !/in memory|WAF_DEMO_NO_PERSISTENCE|not durable/.test(text));
  if (stopped.length > 0) failures.push(`${path} shows a refusal: ${stopped.join(' / ')}`);

  const internal = internalDeliveryLabels(state.text);
  if (internal.length > 0) {
    failures.push(`${path} exposes internal delivery vocabulary: ${internal.join(', ')}`);
  }

  for (const problem of customerHierarchyProblems({
    headings: state.headings,
    emptyCount: state.empty,
    primaryActionLabels: state.primaryActionLabels,
    recommendations: state.recommendations,
  })) {
    failures.push(`${path} ${problem}`);
  }

  const failed = failures.some((one) => one.startsWith(`${path} `));
  console.log(
    `${failed ? '✗' : '✓'} ${path.padEnd(22)} ${String(state.surfaces).padStart(2)} surfaces  ` +
      `${String(state.chars).padStart(5)} chars  ${state.heading.slice(0, 34).padEnd(34)} ${state.numbers.slice(0, 4).join(' ')}`
  );
  if (state.refusals.length > 0) console.log(`    refusal: ${state.refusals.join(' / ')}`);
  return state;
};

for (const path of PAGES) await visit(path);

/*
 * The catch-all, reached the only way it can be.
 *
 * Its failure mode is the one `NotFoundPage` was written to prevent: without a route to catch it React
 * Router shows a developer error page, and the reader loses the shell, the rail and the way back. That
 * page is inside the shell and inside a `Plane`, so it renders a panel like everything else — which is
 * why the copy is asserted as well. A panel here proves something rendered, not that this did.
 */
await visit(MISSING, { shotName: routeScreenshotName('*'), expects: /has no page at that address/i });

/*
 * A route with a `:param` needs an instance, and the app's own links are where one comes from.
 *
 * The alternative is a fixture id per route, which would go stale against a real estate and would say
 * nothing about whether anything links to the page. Harvesting from the pages just driven means the
 * instance is one a reader could actually have clicked. Where nothing linked to a route, that is
 * reported rather than passed over: an estate with no months has no `/months/:month` to open, and a
 * sweep that stays quiet about it is the arrangement this row exists to end.
 */
const unreached = [];
const viaLink = [];
const viaParameter = [];

/**
 * Values already resolved for a named parameter, so a route whose link is behind a disclosure is
 * still reachable.
 *
 * A parameter may only be reused where it names the same identity. That used to let the report borrow
 * `:scanId` from run history. The report now takes `:resultId`, deliberately, so it must be reached
 * from a result link the app actually renders; substituting a raw run id would make this sweep prove
 * the not-found state while claiming it proved a customer report.
 */
const resolved = new Map();

const remember = (path, instance) => {
  const parts = instance.split('/');
  path.split('/').forEach((one, index) => {
    if (one.startsWith(':') && parts[index] != null && parts[index] !== '') resolved.set(one, parts[index]);
  });
};

const parameterised = declared.filter(({ path }) => isParameterised(path)).map(({ path }) => path);

/*
 * Linked instances first, borrowed ones second, because the borrowing must not depend on the order
 * routes happen to be declared in.
 *
 * `/report/:resultId` has no raw-run parameter to borrow. A final result link must have been harvested
 * from the pages already driven; otherwise the report remains in `unreached` and the sweep fails rather
 * than inventing an identity for it.
 */
for (const path of parameterised) {
  const linked = [...seenLinks].find((href) => routePattern(path).test(href.split('?')[0]))?.split('?')[0];
  if (linked == null) continue;
  viaLink.push(path);
  remember(path, linked);
  await visit(linked, { shotName: routeScreenshotName(path) });
}

for (const path of parameterised.filter((one) => !viaLink.includes(one))) {
  const segments = path.split('/');
  if (segments.some((one) => one.startsWith(':') && !resolved.has(one))) {
    unreached.push(path);
    console.log(`· ${path.padEnd(22)} nothing linked to an instance, and no other route resolved its parameter`);
    continue;
  }
  const filled = segments.map((one) => (one.startsWith(':') ? resolved.get(one) : one)).join('/');
  viaParameter.push(path);
  await visit(filled, { shotName: routeScreenshotName(path) });
}

/*
 * One plan, and one action inside it opened the way a reader opens it.
 *
 * The validation trail is the surface over a record no fixture can produce: an attempt a real run
 * answered. Rendering it against the deployed app is what found the three sentences that said the same
 * thing, none of which was visible in a component test where only one of the three modules was mounted.
 */
const planId = process.env.PLAN ?? '';
if (planId !== '') {
  await page.goto(`${origin}/improvements/${planId}`);
  await settle(800);
  await shot('plan-detail');

  const opened = await page.evaluate(`(() => {
    const row = document.querySelector('button.wa-row');
    if (row == null) return false;
    row.click();
    return true;
  })()`);
  if (!opened) failures.push('the plan page listed no action to open');
  await settle(900);

  const read = JSON.parse(
    await page.evaluate(`(() => {
      const text = document.body.innerText;
      return JSON.stringify({
        verified: /verified/i.test(text),
        // A run answered it, and the trail names which run.
        namesTheRun: /by run [0-9a-f-]{8}/i.test(text),
        // Any sentence appearing twice in one panel, which is what three modules composing produces.
        repeated: (() => {
          const said = new Map();
          for (const line of text.split('\\n').map((one) => one.trim()).filter((one) => one.length > 40)) {
            said.set(line, (said.get(line) ?? 0) + 1);
          }
          return [...said].filter(([, count]) => count > 1).map(([line]) => line.slice(0, 60));
        })(),
        refusals: [...document.querySelectorAll('.wa-error, [role="alert"]')].map((n) => n.innerText.trim()),
      });
    })()`)
  );
  await shot('action-detail');

  if (!read.verified) failures.push('the opened action did not read as verified');
  if (!read.namesTheRun) failures.push('the trail did not name the run that answered the attempt');
  if (read.repeated.length > 0) failures.push(`a sentence appears twice on one panel: ${read.repeated.join(' / ')}`);
  if (read.refusals.length > 0) failures.push(`the action panel shows a refusal: ${read.refusals.join(' / ')}`);

  console.log(
    `${failures.length === 0 ? '✓' : '✗'} action        verified:${String(read.verified)}  ` +
      `names the run:${String(read.namesTheRun)}  repeated lines:${String(read.repeated.length)}`
  );
}

page.close();

console.log(`\nScreenshots in ${shots}`);

/*
 * What was driven, said as a count against the table rather than as "every page".
 *
 * The old closing line was "Every page rendered against the deployed app", printed after eighteen of
 * thirty routes. It was not a lie about the pages it opened; it was a claim about a set it had not
 * established, and it is why twelve undriven routes went unnoticed for as long as they did. The
 * numbers below come from the route table, so this sentence cannot outrun what the sweep did.
 */
const drove = PAGES.length + 1 + viaLink.length + viaParameter.length;
console.log(
  `\nDrove ${String(drove)} of ${String(declared.length)} declared routes: ${String(PAGES.length)} pages, ` +
    `the catch-all, ${String(viaLink.length)} at a link this run had seen, and ` +
    `${String(viaParameter.length)} at a parameter another route resolved.`
);
for (const path of unreached) {
  console.log(`  not reached: ${path} — no link to an instance, and no other route resolved its parameter`);
}

/*
 * The stamp, written here because this is the only thing that knows a drive happened.
 *
 * Recorded whether or not the pages rendered: a run that found failures is a run that happened, and the
 * date it establishes is the one `87` exists to make readable. The count beside it says what the run
 * concluded, so an old drive that failed cannot read as verification.
 *
 * Its own failure is reported and does not change the verdict below. This script's answer is about the
 * app; a recording that could not be written is about this script, and losing the fourteen-page verdict
 * to a bookkeeping error is the mistake `shot` above already records making once.
 */
if (process.env.WAF_NO_SERVED_STAMP !== '1') {
  try {
    recordDriven({
      origin,
      profile: process.env.DATABRICKS_CONFIG_PROFILE ?? 'labs',
      drove,
      declared: declared.length,
      failures: failures.length,
      unreached,
    });
    console.log('\nRecorded this drive in scripts/recordings/served.json. Run `npm run served:publish` to state it.');
  } catch (cause) {
    console.log(`\n(the drive was not recorded: ${cause instanceof Error ? cause.message : String(cause)})`);
  }
}

if (failures.length > 0) {
  console.error(`\n${String(failures.length)} pages did not render:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('Every route driven rendered against the deployed app.');
