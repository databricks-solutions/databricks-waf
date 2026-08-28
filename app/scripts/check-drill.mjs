// The customer interface's principal continuations reach the exact records they name.
//
// `check:routes` reads the source and proves each link points at a route that exists and a parameter
// the destination reads. It cannot prove that the rendered link is reachable or that mutable Lakebase
// state preserves the selected record after navigation, so this drives the current customer journeys.
//
//   npm run dev         # in another terminal, with TOKEN and EMAIL for a real scan
//   npm run check:drill

import { open, requireIdentity, requireScan, settle } from './browser.mjs';

const ORIGIN = process.env.ORIGIN ?? 'http://localhost:8000';

/**
 * The routed page, which is where every drill-through is.
 *
 * The default was `body`, and `body` holds the rail before it holds the page: thirty-one navigation
 * links, on every route, ahead of anything a route renders. Two of this check's three standing failures
 * were that and nothing else — `^Met` matched the rail's **Meth**odology, so both reported the app
 * sending a reader to `/methodology` when the links they were aimed at were present and correct
 * (`Met9` to `…&outcome=met` on the pillar, `Met42` to `?outcome=met` on the report).
 *
 * Anchoring the two patterns would have fixed those two and left the next loose pattern to find the
 * rail again. `#content` is `App.tsx`'s `main`, so `#navigation` and `#run-controls` are outside it by
 * construction, and a check written here can no longer match chrome by accident. A drill-through into
 * the rail is not a thing this check tests; one that needs to would pass `body` and say so.
 */
const CONTENT = '#content';
const REQUIRED_CONTENT_CEILING_MS = 10_000;
const REQUIRED_QUIESCE_CEILING_MS = 1_500;

const page = await (async () => {
  requireIdentity();
  await requireScan(ORIGIN);
  return open({ width: 1512, height: 845 });
})();

const results = [];

/**
 * Clicks the first link whose text and href match, within a scope.
 *
 * Reports whether the pointer could actually have reached it: a link covered by another link's
 * overlay answers `elementFromPoint` with the overlay, which is the not-clickable case. Scrolled into
 * view first, because `elementFromPoint` answers null for anything outside the viewport and a pane
 * that scrolls internally would report every row below its fold as unreachable.
 */
async function click(pattern, scope, hrefPattern, destinationReady) {
  const found = await page.evaluate(`(() => {
    const roots = [...document.querySelectorAll(${JSON.stringify(scope)})];
    if (roots.length === 0) return { ok: false, why: 'nothing matches ' + ${JSON.stringify(scope)} };
    const text = new RegExp(${JSON.stringify(pattern)});
    const href = new RegExp(${JSON.stringify(hrefPattern)});
    const link = roots
      .flatMap((root) => [...root.querySelectorAll('a[href]')])
      .find((a) => text.test(a.textContent.trim()) && href.test(a.getAttribute('href')));
    if (link == null) {
      return { ok: false, why: 'no link matching /' + ${JSON.stringify(pattern)} + '/ in ' + ${JSON.stringify(scope)} };
    }
    link.scrollIntoView({ block: 'center' });
    const box = link.getBoundingClientRect();
    const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    const hittable = at != null && (link.contains(at) || at.contains(link) || at === link);
    link.click();
    return { ok: true, text: link.textContent.trim(), href: link.getAttribute('href'), hittable };
  })()`);
  if (!found.ok) throw new Error(found.why);
  await waitForRequiredContent(destinationReady, 'the page the click opened');
  return found;
}

async function hasLink(pattern, scope = CONTENT, hrefPattern = '') {
  return page.evaluate(`(() => {
    const text = new RegExp(${JSON.stringify(pattern)});
    const href = new RegExp(${JSON.stringify(hrefPattern)});
    return [...document.querySelectorAll(${JSON.stringify(scope)})]
      .flatMap((root) => [...root.querySelectorAll('a[href]')])
      .some((link) => text.test(link.textContent.trim()) && href.test(link.getAttribute('href')));
  })()`);
}

async function waitForRequiredContent(check, what) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= REQUIRED_CONTENT_CEILING_MS) {
    if (await check()) {
      await settle(100);
      return;
    }
    await settle(80);
  }
  throw new Error(
    `${what} did not render its required customer content within ${String(REQUIRED_CONTENT_CEILING_MS)}ms`
  );
}

/**
 * Navigates and waits for the customer content this assertion needs.
 *
 * These routes also issue background reads that do not decide whether the named continuation exists.
 * Waiting on every request made the gate take more than fifteen minutes and still fail after the
 * customer content was rendered. The viewport and accessibility gates separately own complete-page
 * readiness; this gate waits only for the payload its assertion reads.
 */
async function visit(path, ready) {
  await page.goto(`${ORIGIN}${path}`, { ceiling: REQUIRED_QUIESCE_CEILING_MS });
  await waitForRequiredContent(ready, path);
}

const here = () => page.evaluate('location.pathname + location.search');

/**
 * Clicks the first row of a list, which on the master-detail pages is a button rather than a link.
 *
 * Those rows are the app's most-used drill-through and the one `click` above cannot see: they put the
 * selection in the URL and open a pane beside the list, so what has to be checked is that the pane is
 * showing the row that was clicked rather than the first row of the list. Both halves have been wrong
 * here before — see selectionFrom.
 */
function selects(
  name,
  path,
  param,
  { scope = '[aria-label="Requirements that need an answer"]', pane = 'Selected requirement' } = {}
) {
  return check(name, async () => {
    await visit(path, () =>
      page.evaluate(`document.querySelector(${JSON.stringify(scope)})?.querySelector('button') != null`)
    );
    const clicked = await page.evaluate(`(() => {
      const list = document.querySelector(${JSON.stringify(scope)});
      // The second row, so a pane that shows the first regardless would be caught.
      const buttons = list == null ? [] : [...list.querySelectorAll('ul button')];
      const button = buttons[1] ?? buttons[0] ?? null;
      if (button == null) return { ok: false, why: 'no clickable row in ' + ${JSON.stringify(scope)} };
      button.scrollIntoView({ block: 'center' });
      const box = button.getBoundingClientRect();
      const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      const hittable = at != null && (button.contains(at) || at.contains(button) || at === button);
      button.click();
      return { ok: true, text: button.textContent.trim().slice(0, 44), hittable };
    })()`);
    if (!clicked.ok) throw new Error(clicked.why);
    await waitForRequiredContent(async () => {
      const landed = await here();
      const asked = new URLSearchParams(landed.split('?')[1] ?? '').get(param);
      if (asked == null) return false;
      const shows = await page.evaluate(
        `document.querySelector('[aria-label=' + ${JSON.stringify(`"${pane}"`)} + ']')?.textContent ?? ''`
      );
      return shows.includes(asked);
    }, 'the selected record');

    const landed = await here();
    const asked = new URLSearchParams(landed.split('?')[1] ?? '').get(param);
    const shows = await page.evaluate(
      `document.querySelector('[aria-label=' + ${JSON.stringify(`"${pane}"`)} + ']')?.textContent ?? ''`
    );
    const agrees = asked != null && shows.includes(asked);
    return {
      pass: agrees && clicked.hittable,
      text:
        `"${clicked.text}" -> ${landed}` +
        (asked == null ? ` | no ${param} in the address` : ` | pane shows ${agrees ? asked : 'something else'}`) +
        (clicked.hittable ? '' : ' | NOT CLICKABLE'),
    };
  });
}

async function check(name, run) {
  try {
    const detail = await run();
    results.push({ name, pass: detail.pass, detail: detail.text });
  } catch (cause) {
    results.push({ name, pass: false, detail: cause.message });
  }
}

/** Follows a link and checks where it landed. */
function lands(name, path, pattern, expect, { scope = CONTENT, href = '' } = {}) {
  return check(name, async () => {
    await visit(path, () => hasLink(pattern, scope, href));
    const link = await click(pattern, scope, href, async () => new RegExp(expect).test(await here()));
    const landed = await here();
    const ok = new RegExp(expect).test(landed);
    return {
      pass: ok && link.hittable,
      text: `"${link.text}" -> ${landed}${link.hittable ? '' : ' | NOT CLICKABLE'}${ok ? '' : ` | expected ${expect}`}`,
    };
  });
}

try {
  // The Dashboard is either holding an unfinished review or showing a published result. Both states
  // lead with one exact continuation rather than exposing a raw record directory.
  await lands(
    'dashboard: continue the result',
    '/overview',
    '^(Continue review|Open report)$',
    '^/(review|report)/[0-9a-f-]+'
  );
  await lands(
    'dashboard: inspect the evidence',
    '/overview',
    '^(Inspect collected evidence|View all \\d+)$',
    '^/(history/[0-9a-f-]+|investigate\\?outcome=unmet)'
  );

  // The open review joins a human question and its collected source run to their exact records.
  await visit('/overview', () => hasLink('^Continue review$', CONTENT, '^/review/[0-9a-f-]+'));
  const reviewPath = await page.evaluate(`(() => {
    const pattern = /^\\/review\\/[0-9a-f-]+/;
    return [...document.querySelectorAll(${JSON.stringify(CONTENT)} + ' a[href]')]
      .map((link) => link.getAttribute('href'))
      .find((href) => href != null && pattern.test(href)) ?? null;
  })()`);
  if (reviewPath == null) throw new Error('Dashboard did not name the open review it continues');
  await lands('review: first question', reviewPath, '^Unanswered', '^/answers/walk\\?pillar=.+&control=');
  await lands('review: collected run', reviewPath, '^(This run|Collected run)$', '^/history/[0-9a-f-]+');

  // The recurring inbox owns the unfinished review and the improvement register.
  await lands(
    'operate: dominant continuation',
    '/operate',
    '^(Choose a review|Resume review|Open run record|Open Dashboard)$',
    '^/(review(?:/[0-9a-f-]+)?|history/[0-9a-f-]+|overview)(?:\\?.*)?$'
  );
  await lands('operate: improvement register', '/operate', '^All improvement work$', '^/improvements$');

  // The master-detail human-evidence row and immutable run row keep identity through navigation.
  await selects('answers: row opens it', '/answers', 'control');
  await lands('history: run row', '/history', '\\d{4}|\\d+:\\d+', '^/history/[0-9a-f-]+', { scope: '.wa-table' });

  // Until publication, each customer workspace says where the unfinished assessment is owned. Once
  // publication exists these routes expose their richer finding/report links, which the deterministic
  // acceptance matrix covers independently of mutable Lakebase state.
  // Multiple open reviews deliberately land on the chooser; one open review may continue directly to
  // its exact record. Both destinations preserve customer ownership instead of choosing an arbitrary
  // latest review.
  await lands('investigate: publication owner', '/investigate', '^Open review$', '^/review(?:/[0-9a-f-]+)?$');
  await visit('/improvements', () =>
    Promise.all([
      hasLink('^Review opportunities$', CONTENT, '^/workloads$'),
      hasLink('.+', '[aria-label="Improvement plans"]', '^/improvements/[0-9a-f-]+$'),
    ]).then((states) => states.some(Boolean))
  );
  if (await hasLink('.+', '[aria-label="Improvement plans"]', '^/improvements/[0-9a-f-]+$')) {
    await lands('improve: open plan', '/improvements', '.+', '^/improvements/[0-9a-f-]+$', {
      scope: '[aria-label="Improvement plans"]',
      href: '^/improvements/[0-9a-f-]+$',
    });
  } else {
    await lands('improve: opportunity source', '/improvements', '^Review opportunities$', '^/workloads$');
  }
  await lands('report: publication owner', '/report', '^(Continue review|Open Dashboard)$', '^/(review|overview)$');
} finally {
  page.close();
}

for (const { name, pass, detail } of results) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(28)} ${detail}`);
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${String(results.length - failed.length)}/${String(results.length)} drill-throughs behave.`);
process.exit(failed.length === 0 ? 0 : 1);
