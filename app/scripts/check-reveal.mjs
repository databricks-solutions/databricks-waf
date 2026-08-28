// A link to a row, opened cold, puts that row's pane on screen.
//
// `check:drill` clicks a link from inside the app and asks whether the destination holds what the link
// promised. This asks the other half of the same question: whether a reader who arrives at that URL
// without passing through the app — a bookmark, a link in a ticket, a page reloaded — is shown the
// thing it names. On a phone the two are completely different journeys, because the panes stack and
// the pane is below the fold.
//
// It exists because `useRevealedPane` claimed to handle this and did not, on every page that uses it,
// for as long as the hook had existed. Every unit test passed: the hook's only tested part is
// `offscreen`, which was correct, and the defect was in when the effect got to run. `/findings` opened
// cold at 390x844 put the pane 818px down a fold of 844 and left it there — 26px of it showing, which
// is the same 26px the page shows with no row named at all.
//
// So it is measured in a browser at a size where being wrong is visible, and the assertion is the
// hook's own: at least `ENOUGH` pixels of the pane, from `reveal.ts`. Under ADR 0108 this remains a
// best-effort compact-layout diagnostic; tablet and mobile results do not block the pilot.
//
//   npm run dev         # in another terminal, with a scan run in it
//   npm run check:reveal
//
// The URLs are not hardcoded. Each route is opened with nothing selected, its first row is clicked,
// and whatever the app puts in the query string is then loaded as a fresh navigation. So the check
// tests the URL the app itself produces for that row, on an estate it has not been told anything
// about.
//
// Clicking rather than reading an href, because a row is a `button` that sets the query string. There
// is no anchor to read, and the first version of this check reported every route as having no rows for
// that reason while looking at pages full of them.

import { open, requireIdentity, requireScan, settle } from './browser.mjs';

/**
 * How long a scroll is given to finish after the page has settled.
 *
 * `goto` waits for the canvas to stop moving; the hook then watches the pane for up to `DEADLINE`
 * before deciding, and scrolls. Under reduced motion the scroll is instant, so this covers the hook's
 * own deadline rather than an animation, and is sized against it.
 */
const SCROLLED = 2_000;

/** How long a click is given to reach the query string, which a router writes on the next render. */
const SELECTED = 300;

const ORIGIN = process.env.ORIGIN ?? 'http://localhost:8000';

/** The phone the panes stack on. Above 900px the pane is beside the list and must never scroll. */
const WIDTH = 390;
const HEIGHT = 844;

/**
 * The least of the pane worth having on screen, in pixels. `ENOUGH` in `reveal.ts`.
 *
 * Duplicated rather than imported because this is a `.mjs` script run unbuilt and the hook is a `.ts`
 * module in the client bundle. A test holds the two together: `reveal.test.ts` asserts the constant.
 */
const ENOUGH = 120;

/**
 * Every page that calls `useRevealedPane`, where its pane is, and how to reach the page.
 *
 * `at` is the address the reader has; `from` is the index a page nested under an id is reached
 * through, because `/improvements/:planId` and `/review/:reviewId` have no address until a row on the
 * index has named one.
 *
 * The destinations are written out because each route names its selected task differently; a generic
 * selector could match the queue and report the requested task as revealed when it is still off-screen.
 *
 * Keeping this list in step with `App.tsx` is the check's own weak point and has already cost it two
 * routes: `/attestations` and `/plan` were both guesses, both served the not-found page, and both were
 * reported as estates with no rows in them rather than as addresses that do not exist. That is why a
 * page carrying the not-found heading is now a failure below.
 */
const ROUTES = [
  { at: '/findings', pane: 'section[aria-label="Selected requirement"]' },
  { at: '/answers', pane: 'section[aria-label="Selected requirement"]' },
  { at: '/decisions', pane: 'section[aria-label="Selected decision"]' },
  { at: '/exceptions', pane: 'section[aria-label="Selected acceptance"]' },
  { at: '/warehouses', pane: 'section[aria-label="Selected warehouse opportunity"]' },
  { at: '/jobs', pane: 'section[aria-label="Selected job opportunity"]' },
  { at: '/serverless', pane: 'section[aria-label="Selected serverless migration"]' },
  { at: '/workloads', pane: 'section[aria-label="Selected query opportunity"]' },
  { at: '/writes', pane: 'section[aria-label="Selected write opportunity"]' },
  { at: '/checks', pane: 'section[aria-label$="checks"]' },
  { from: '/improvements', pane: 'section[aria-label="Selected improvement action"]' },
];

requireIdentity();
await requireScan(ORIGIN);

const page = await open({ width: WIDTH, height: HEIGHT });

// Reduced motion, so the hook's `gently()` chooses an instant scroll and the measurement below is of
// where the page ended up rather than of how far through an animation it was. The hook honours the
// preference explicitly for exactly this reason; emulating it here removes the only timing this check
// would otherwise be sensitive to.
await page.send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
});

/** Whether the address just opened is one the app serves. See `NotFoundPage`. */
async function served() {
  const heading = await page.evaluate("document.querySelector('#content h1, #content h2')?.textContent ?? ''");
  return typeof heading === 'string' && !heading.includes('no page at that address');
}

/** Clicks this page's first row and returns where that put the reader, or null if there are no rows. */
async function followFirstRow() {
  const clicked = await page.evaluate(`(() => {
    const row = document.querySelector('#content .wa-record-action, #content .wa-row');
    if (row == null) return false;
    row.click();
    return true;
  })()`);
  if (clicked !== true) return null;

  await settle(SELECTED);
  const url = await page.evaluate('location.pathname + location.search');
  return typeof url === 'string' ? url : null;
}

/** How much of the pane is on screen, and where the document is, once the page has settled. */
async function paneShowing(selector) {
  return page.evaluate(`(() => {
    const pane = document.querySelector(${JSON.stringify(selector)});
    if (pane == null) return null;
    const box = pane.getBoundingClientRect();
    return {
      showing: Math.round(Math.min(box.bottom, window.innerHeight) - Math.max(box.top, 0)),
      top: Math.round(box.top),
      scrollY: Math.round(window.scrollY),
    };
  })()`);
}

const results = [];

for (const route of ROUTES) {
  const entry = route.at ?? route.from;
  await page.goto(`${ORIGIN}${entry}`);

  if (!(await served())) {
    results.push({ route: entry, state: 'failed', why: 'this app serves no page at that address' });
    continue;
  }

  // A page nested under an id is reached through its index, and the row that reaches it is not the row
  // whose pane this measures — so the first click navigates and the second selects.
  if (route.from != null) {
    const opened = await followFirstRow();
    if (opened == null || opened === entry) {
      results.push({ route: entry, state: 'unmeasured', why: 'the index has nothing to open' });
      continue;
    }
    // The page that click navigated to has to render before its rows can be clicked. `SELECTED` is
    // sized for a router writing a query string, and reading the destination that soon reported
    // `/improvements` as an estate with nothing in it while a plan with an action was on screen — the
    // false negative this check exists to make impossible.
    await page.quiesce();
  }

  const href = await followFirstRow();
  if (href == null || !href.includes('?')) {
    results.push({ route: entry, state: 'unmeasured', why: 'no row here selects anything' });
    continue;
  }

  // A fresh navigation rather than a click, because a click is the case that already worked. What this
  // measures is the render where the id is known and the pane is not.
  await page.goto(`${ORIGIN}${href}`);
  await settle(SCROLLED);

  const measured = await paneShowing(route.pane);
  if (measured == null) {
    results.push({ route: href, state: 'failed', why: `no element matched ${route.pane}` });
    continue;
  }

  results.push({
    route: href,
    state: measured.showing >= ENOUGH ? 'ok' : 'failed',
    ...measured,
  });
}

await page.close();

const failed = results.filter((one) => one.state === 'failed');
const unmeasured = results.filter((one) => one.state === 'unmeasured');

for (const one of results) {
  if (one.state === 'ok') {
    console.log(`  ok         ${one.route} — ${String(one.showing)}px of the pane, at scrollY ${String(one.scrollY)}`);
  } else if (one.state === 'failed' && one.why != null) {
    console.log(`  FAILED     ${one.route} — ${one.why}`);
  } else if (one.state === 'failed') {
    console.log(
      `  FAILED     ${one.route} — ${String(one.showing)}px showing of a ${String(HEIGHT)}px fold, ` +
        `pane top ${String(one.top)}, scrollY ${String(one.scrollY)}`
    );
  } else {
    console.log(`  unmeasured ${one.route} — ${one.why}`);
  }
}

console.log('');
console.log(
  `${String(results.length - failed.length - unmeasured.length)} of ${String(results.length)} routes ` +
    `show at least ${String(ENOUGH)}px of the pane a deep link names, at ${String(WIDTH)}x${String(HEIGHT)}.`
);

if (unmeasured.length > 0) {
  console.log(
    `${String(unmeasured.length)} could not be measured, and that is not a pass: a route with no rows on ` +
      'this estate is a route this check did not test. Run it against an estate that fills them.'
  );
}

if (failed.length > 0) process.exitCode = 1;
