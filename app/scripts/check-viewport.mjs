// Every canvas fits the window it is rendered in, and every customer document remains readable.
//
// CustomerPage uses normal document flow. Record queues page at an intentional bound; task detail,
// disclosures and reports extend the shell-owned scrolling region rather than clipping customer content.
//
// So it is measured. Two window sizes, both themes, every page: each CustomerPage may extend the
// document in normal flow, while its bounded record lists retain explicit pagination. The rendered
// `.wa-customer-page` class proves the route uses that contract rather than a compatibility canvas.
//
// Nothing may scroll sideways, including the printable report. This rule was added after a sweep found
// twenty-eight sideways scrollers nobody had noticed: the
// SQL and CLI snippets on the findings pane ran 947px past its edge and the report's ran 1007px, so a
// command the reader is meant to copy and run could not be read without dragging. A fold costs a line
// and a drag costs the reader, which makes a sideways scrollbar here a bug rather than a choice.
//
// Every page is measured as it lands, with each disclosure opened one at a time over that state, and
// once more with every disclosure open. One-at-a-time is what a reader usually does; all-open is one
// extra click and is the state `/history` spilled in — `96`. All pairs is 2^n and is not the answer.
//
//   npm run dev            # in another terminal, with a scan run in it
//   npm run check:viewport
//
// `SHOTS=/tmp/waf-shots` writes a PNG per combination, which is how a layout complaint gets answered
// with a picture rather than an argument.
//
// What this checks is the settled layout. `goto` waits for data and geometry to quiesce before any
// measurement, so a warm development server cannot make an unsettled page look approved.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { open, requireIdentity, requireScan, routeRestCeiling } from './browser.mjs';
import { coverageProblems, productionRoutes, routerSource } from './routes.mjs';

const ORIGIN = process.env.ORIGIN ?? 'http://localhost:8000';
const SHOTS = process.env.SHOTS ?? null;
/**
 * Narrow the sweep while iterating. Coverage still holds the full list: a token that matches nothing
 * fails before Chrome starts, so a typo cannot silently measure three pages and call it the app.
 */
const ASKED = process.env.ROUTES?.split(',') ?? null;

/** The supported pilot browser windows: wide desktop and laptop, inside Chrome's own frame. */
const WINDOWS = [
  { name: '1512x845', width: 1512, height: 845 },
  { name: '1280x800', width: 1280, height: 800 },
];
const ASKED_WINDOWS = process.env.VIEWPORTS?.split(',') ?? null;
const RUN_WINDOWS = ASKED_WINDOWS == null ? WINDOWS : WINDOWS.filter(({ name }) => ASKED_WINDOWS.includes(name));
if (ASKED_WINDOWS != null && RUN_WINDOWS.length === 0) {
  process.stderr.write('VIEWPORTS matched no supported viewport.\n');
  process.exit(1);
}
const SCHEMES = ['light', 'dark'];
const ASKED_SCHEMES = process.env.SCHEMES?.split(',') ?? null;
const RUN_SCHEMES = ASKED_SCHEMES == null ? SCHEMES : SCHEMES.filter((scheme) => ASKED_SCHEMES.includes(scheme));
if (ASKED_SCHEMES != null && RUN_SCHEMES.length === 0) {
  process.stderr.write('SCHEMES matched no supported colour scheme.\n');
  process.exit(1);
}

/**
 * Every page a reader lands on, including one pillar's detail — the deepest layout in the app, with a
 * scrolling summary rail beside a paged list.
 *
 * Hand-written rather than read from the router, and it has to be: `history-job` is a view that shares a
 * route with another and every row carries a name for its screenshots. None of
 * that is in the route table. What *is* the route table's business is whether this list is complete, and
 * it was not — `/warehouses`, `/jobs`, `/exceptions` and `/improvements` were served and never measured
 * here. `coverageProblems` below is that half, and it is the reason a curated list is still safe.
 */
const PAGES = [
  // `/` keeps the first-visit orientation contract; `/overview` is the stable, always-reachable
  // state-of-the-nation destination and must be measured in its own right.
  { name: 'landing', path: '/' },
  { name: 'overview', path: '/overview' },
  // Orientation is a customer document, not a fixed workbench. Its limits and optional glossary stay
  // in the page's reading order, so opening the glossary may extend the document vertically.
  { name: 'start', path: '/start' },
  { name: 'pillars', path: '/pillars' },
  { name: 'pillar-detail', path: '/pillars/security-compliance-and-privacy' },
  { name: 'findings', path: '/findings' },
  // Investigation is the finding-to-fix journey and must remain in the same route matrix as its
  // specialist resource views.
  { name: 'investigate', path: '/investigate' },
  { name: 'methodology', path: '/methodology' },
  { name: 'definitions', path: '/definitions' },
  { name: 'definitions-setup', path: '/definitions/setup' },
  { name: 'checks', path: '/checks' },
  { name: 'answers', path: '/answers' },
  { name: 'answers-walk', path: '/answers/walk' },
  // Review is a decision document: all seven pillar records remain in one reading order. It scrolls
  // vertically by design and is still held to the horizontal and rendered-surface rules.
  { name: 'review', path: '/review' },
  { name: 'decisions', path: '/decisions' },
  { name: 'exceptions', path: '/exceptions' },
  { name: 'improvements', path: '/improvements' },
  { name: 'workloads', path: '/workloads' },
  { name: 'warehouses', path: '/warehouses' },
  { name: 'jobs', path: '/jobs' },
  { name: 'serverless', path: '/serverless' },
  { name: 'writes', path: '/writes' },
  // Shipped by `45c` on a day labs was unreachable, and unmeasured here until `63` ran the sweeps against
  // a scan again. It is the composed page this rule is most likely to break: eight dimensions with their
  // shares, a declaration with its fingerprint, and an absence list, in one column.
  { name: 'foundation', path: '/foundation' },
  { name: 'topology', path: '/topology' },
  { name: 'history', path: '/history' },
  // The runs table's other view, which is a different table in the same room: its own columns, its own
  // row heights and its own pager. Listed because it is where this rule was broken worst — the job's runs
  // were a disclosure in the schedule panel, and opening it took the scan history to 13px and scrolled the
  // document. A view that shares a route is invisible to a sweep of routes unless it is named.
  { name: 'history-job', path: '/history?runs=job' },
  { name: 'report', path: '/report' },
  // The recurring return point has a review queue beside two stacked record summaries. It is the
  // composition most likely to overflow once unattended runs accumulate, so measure the real list.
  // Operate is the recurring inbox followed by its durability records, in normal customer-document
  // flow. It may scroll vertically and may never make a reader drag sideways.
  { name: 'operate', path: '/operate' },
  // A month keeps its action first and puts technical provenance behind disclosures. The record grows
  // when those disclosures open, so it reads down the document rather than inside a nested scroller.
  { name: 'months', path: '/months' },
  { name: 'diagnostics', path: '/diagnostics' },
  { name: 'trail', path: '/trail' },
  // Retention is a policy record whose optional class inventories remain in normal reading order.
  { name: 'retention', path: '/retention' },
];

/**
 * Routes this sweep does not measure, each with the reason. Held against the router, so an exemption that
 * outlives its route fails rather than sitting there reading like a decision about the app as it is.
 */
const NOT_MEASURED = new Map([
  ['*', 'the catch-all, which has no path of its own'],
  // Keyed by a record a sweep of static paths cannot name. A made-up id renders the not-found state, so
  // measuring one would be measuring an empty page and calling it the page. `drive-labs.mjs` reaches
  // these by following a link to an instance that exists.
  ['/review/:reviewId', 'keyed by a review that has to exist; reached from a link in drive-labs.mjs'],
  ['/history/:scanId', 'keyed by a run that has to exist; reached from a link in drive-labs.mjs'],
  ['/report/:resultId', 'keyed by a final result that has to exist; reached from a link in drive-labs.mjs'],
  ['/improvements/:planId', 'keyed by a plan that has to exist; reached from a link in drive-labs.mjs'],
  ['/months/:month', 'keyed by a published month that has to exist; reached from a link in drive-labs.mjs'],
]);

// Before Chrome starts: the failure is about the list, and finding out after the sweep that the list was
// short of the app wastes the run that was supposed to answer for it.
const uncovered = coverageProblems(PAGES, {
  exempt: NOT_MEASURED,
  what: 'measured by check:viewport',
  routes: productionRoutes(routerSource()),
});
if (uncovered.length > 0) {
  process.stderr.write('check:viewport does not cover the app it says it covers.\n\n');
  for (const problem of uncovered) process.stderr.write(`  - ${problem}\n`);
  process.exit(1);
}

const RUN =
  ASKED == null ? PAGES : PAGES.filter((page) => ASKED.some((token) => token === page.path || token === page.name));
if (ASKED != null && RUN.length === 0) {
  process.stderr.write('ROUTES matched no page in the viewport list.\n');
  process.exit(1);
}

/** Taken in the page, because these are all questions about boxes after layout. */
const PROBE = `(() => {
  const doc = document.documentElement;
  const canvas = document.querySelector('main#content');
  return {
    // The shell locks the document at 100dvh, so any scroll here is a page that has escaped it.
    documentScrolls: doc.scrollHeight > window.innerHeight + 1,
    // Customer documents use this one shell-owned scrolling region.
    canvasOverflow: canvas == null ? null : canvas.scrollHeight - canvas.clientHeight,
    /*
     * Anything the reader would have to drag sideways to finish reading.
     *
     * Only boxes that actually scroll count: an overflow-x of auto or scroll, with content wider than
     * the box. A too-wide child of a hidden or visible parent is clipping or bleeding, which are
     * different bugs with different fixes, and the rules above catch the ones that matter. The class
     * name comes back so that the failure can name the thing.
     */
    sideways: [
      ...(doc.scrollWidth > doc.clientWidth + 1 ? [{ what: 'the document', over: doc.scrollWidth - doc.clientWidth }] : []),
      ...[...document.querySelectorAll('*')]
        .filter((node) => node.scrollWidth > node.clientWidth + 1)
        .filter((node) => ['auto', 'scroll'].includes(getComputedStyle(node).overflowX))
        .map((node) => ({
          what: node.className.toString().split(/\\s+/).find((name) => name.startsWith('wa-')) ?? node.tagName.toLowerCase(),
          over: node.scrollWidth - node.clientWidth,
        })),
    ],
    customerPages: document.querySelectorAll('.wa-customer-page').length,
    customerSurfaces: document.querySelectorAll('.wa-customer-surface').length,
    empty: document.querySelectorAll('.wa-empty, .wa-empty-state').length,
  };
})()`;

/**
 * Every disclosure on the page, with the state it shipped in.
 *
 * The sweep measured only pages as they landed for as long as it existed, which left a whole state of
 * the app unmeasured — and not a rare one, since a disclosure is one click and the app puts a great
 * deal behind them.
 *
 * The shipped state is read as well as the summary because it is not always closed. `ServerlessPage`
 * renders one with `open` (client/src/pages/ServerlessPage.tsx:395), and a sweep that closes it to
 * measure the others one at a time measures a page no reader arrives at.
 */
const DISCLOSURES = `(() => [...document.querySelectorAll('details')].map((one) => ({
  summary: (one.querySelector('summary')?.textContent ?? '').trim().slice(0, 60),
  shipped: one.open,
})))()`;

/**
 * The page as it shipped, plus one disclosure the reader has opened.
 *
 * One at a time first, because that is what a reader usually does. All of them open is a second
 * pass below, not this function: two open on `/history` is one more click, and this helper would
 * close the first to measure the second. Closing the ones that shipped open measures a different
 * state nobody is in, which is what this did before: `open = at === index` closed every other
 * disclosure on the page, whatever it shipped as.
 *
 * `contains` is true of a node itself, so this opens the target and every disclosure that holds it.
 * Without the ancestors a nested target is set open inside a closed parent, and the page then measures
 * as fitting however tall the target is — a silent pass rather than a measurement. Measured on /checks
 * at 1512x845 with a 220px disclosure put inside the page's second one, Chrome for Testing
 * 150.0.7871.24: with the parent closed the canvas overflows by 0px and the parent stands at 18px,
 * with the parent open the same target overflows the canvas by 145px and the parent stands at 550px.
 * The target keeps a box of 220px either way — it is not that it renders hidden, which is what this
 * comment claimed before anyone measured it, but that the closed ancestor does not take its height.
 *
 * The app nests them at client/src/components/EvidenceImport.tsx:115, inside the checks page's second
 * disclosure at client/src/pages/ChecksPage.tsx:202. That pairing needs a requirement that is grantable
 * to nobody and at least one imported collection, and the labs estate has neither, so the nesting is
 * read from the source and the rule is measured against an injected one. No page in the sweep nests a
 * disclosure on this estate: twenty pages, every disclosure opened, no `details` inside another.
 */
const shownWith = (index, shipped) => `(() => {
  const was = ${JSON.stringify(shipped)};
  const all = [...document.querySelectorAll('details')];
  const target = all[${String(index)}];
  if (target == null) return false;
  all.forEach((one, at) => (one.open = one.contains(target) || was[at] === true));
  return true;
})()`;

/** The page put back the way it shipped, so the next disclosure is measured from the same start. */
const asShipped = (shipped) => `(() => {
  const was = ${JSON.stringify(shipped)};
  [...document.querySelectorAll('details')].forEach((one, at) => (one.open = was[at] === true));
})()`;

if (SHOTS != null) mkdirSync(SHOTS, { recursive: true });

const missingShots = [];
async function writeShot(page, window, name) {
  if (SHOTS == null) return;
  try {
    const shot = await page.screenshot({ x: 0, y: 0, width: window.width, height: window.height, scale: 1 });
    writeFileSync(join(SHOTS, name), shot);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    missingShots.push(`${name}: ${reason}`);
    process.stderr.write(`could not capture ${name}: ${reason}\n`);
  }
}

requireIdentity();
await requireScan(ORIGIN);
const page = await open({ width: RUN_WINDOWS[0].width, height: RUN_WINDOWS[0].height });

const failures = [];
const rows = [];

try {
  for (const scheme of RUN_SCHEMES) {
    await page.prefer(scheme);

    for (const window of RUN_WINDOWS) {
      await page.resize(window.width, window.height);

      for (const target of RUN) {
        process.stderr.write(`measuring ${target.name} at ${window.name} in ${scheme}\n`);
        const ceiling = routeRestCeiling(target.path);
        const arrival = await page.goto(`${ORIGIN}${target.path}`, ceiling == null ? {} : { ceiling });
        const measured = await page.evaluate(PROBE);
        rows.push({ scheme, window: window.name, page: target.name, ...measured });

        const where = `${target.name} at ${window.name} in ${scheme}`;
        // Every number below is of the page as it was when this was read, so a page that had not
        // finished arriving invalidates the reading rather than qualifying it. See `97`.
        if (!arrival.settled) {
          failures.push(`${where}: still not at rest after ${String(arrival.waited)}ms — ${arrival.reason}`);
        }
        if (measured.customerPages === 0) {
          failures.push(`${where}: does not render the customer page system`);
        }
        if (measured.customerSurfaces === 0 && measured.empty === 0) {
          failures.push(`${where}: rendered nothing`);
        }

        // The sideways rule is the one the report is held to as well.
        for (const scroller of measured.sideways) {
          failures.push(`${where}: ${scroller.what} scrolls sideways by ${String(scroller.over)}px`);
        }

        if (measured.documentScrolls) failures.push(`${where}: the document escapes the shell scroll region`);

        await writeShot(page, window, `${target.name}-${window.name}-${scheme}.png`);

        /*
         * The same page again with each disclosure the reader can open, one at a time, over the state
         * the page shipped in.
         *
         * In the same page load rather than a fresh one, because a `<details>` is opened by a property
         * and needs no navigation — so this costs a `quiesce` per disclosure against the `goto` the
         * measurement above already paid for. Reusing the load is also the only way the slack rule below
         * says anything: it holds the list to growing back when the disclosure that squeezed it closes.
         *
         * The report is exempt from the fit rules and keeps its exemption here; the sideways rule still
         * applies to it, and a disclosure is as able to break that as anything else.
         */
        // `DISCLOSURES=0` skips the open-disclosure pass. The failures `99` named were on the page
        // as it landed; the combinations are `96`. A full run still opens them.
        if (process.env.DISCLOSURES === '0') continue;

        const disclosures = await page.evaluate(DISCLOSURES);
        const shipped = disclosures.map((one) => one.shipped);

        for (const [index, one] of disclosures.entries()) {
          // A disclosure that ships open has already been measured, by the measurement above: the page
          // as it lands is the page with that disclosure open. Opening it again would report the same
          // reading twice under a second name.
          if (one.shipped) continue;

          await page.evaluate(shownWith(index, shipped));
          const settledOpen = await page.quiesce();

          const opened = await page.evaluate(PROBE);
          const named = one.summary === '' ? `disclosure ${String(index + 1)}` : `"${one.summary}"`;
          const where = `${target.name} at ${window.name} in ${scheme} with ${named} open`;

          // Opening one is as able to start a query as arriving is, so the reading below is worth no more
          // than the settle behind it. Reported rather than skipped: a measurement taken of a moving page
          // is what `97` is about, and a silent one is how it went unnoticed for months.
          if (!settledOpen.settled) {
            failures.push(`${where}: still not at rest after ${String(settledOpen.waited)}ms — ${settledOpen.reason}`);
          }
          rows.push({
            scheme,
            window: window.name,
            page: `${target.name} (${named} open)`,
            ...opened,
          });

          for (const scroller of opened.sideways) {
            failures.push(`${where}: ${scroller.what} scrolls sideways by ${String(scroller.over)}px`);
          }

          if (opened.customerPages === 0) failures.push(`${where}: does not render the customer page system`);
          if (opened.documentScrolls) failures.push(`${where}: the document escapes the shell scroll region`);

          await writeShot(page, window, `${target.name}-${window.name}-${scheme}-open-${String(index + 1)}.png`);

          await page.evaluate(asShipped(shipped));
          const settledShut = await page.quiesce();
          if (!settledShut.settled) {
            failures.push(
              `${target.name} at ${window.name} in ${scheme} after shutting ${named}: still not at rest ` +
                `after ${String(settledShut.waited)}ms — ${settledShut.reason}`
            );
          }
        }

        /*
         * Then every disclosure at once. One-at-a-time is what a reader usually does; two open is
         * one more click and is what `/history` did — `96`. All pairs is 2^n and is not the answer;
         * all of them open is one extra state per page and is the cheapest thing that would have
         * caught that. Pages with one disclosure have already been measured.
         */
        if (disclosures.filter((one) => !one.shipped).length >= 1 && disclosures.length >= 2) {
          await page.evaluate(`(() => {
            [...document.querySelectorAll('details')].forEach((one) => { one.open = true; });
          })()`);
          const settledAll = await page.quiesce();
          const opened = await page.evaluate(PROBE);
          const where = `${target.name} at ${window.name} in ${scheme} with every disclosure open`;
          if (!settledAll.settled) {
            failures.push(`${where}: still not at rest after ${String(settledAll.waited)}ms — ${settledAll.reason}`);
          }
          rows.push({
            scheme,
            window: window.name,
            page: `${target.name} (every disclosure open)`,
            ...opened,
          });
          for (const scroller of opened.sideways) {
            failures.push(`${where}: ${scroller.what} scrolls sideways by ${String(scroller.over)}px`);
          }
          if (opened.customerPages === 0) failures.push(`${where}: does not render the customer page system`);
          if (opened.documentScrolls) failures.push(`${where}: the document escapes the shell scroll region`);
          await page.evaluate(asShipped(shipped));
        }
      }
    }
  }
} finally {
  page.close();
}

for (const row of rows) {
  console.log(
    [
      row.scheme.padEnd(5),
      row.window,
      row.page.padEnd(14),
      `canvas ${String(row.canvasOverflow).padStart(4)}px`,
      `sideways ${String(row.sideways.length)}`,
    ].join('  ')
  );
}

if (SHOTS != null) console.log(`\nScreenshots in ${SHOTS}`);

if (missingShots.length > 0) {
  console.error(`\n${String(missingShots.length)} screenshots were not captured:`);
  for (const missing of missingShots) console.error(`  ${missing}`);
}

if (failures.length > 0) {
  console.error(`\n${String(failures.length)} layout failures:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

if (missingShots.length > 0) process.exit(1);

console.log(`\nAll ${String(rows.length)} page renders fit their window.`);
