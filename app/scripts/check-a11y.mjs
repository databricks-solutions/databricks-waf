// WCAG 2.2 AA, measured in the rendered page rather than asserted in a document.
//
// The brief names WCAG 2.2 AA as the target and the audit found the app short of it in ways no static
// check could see: a status told apart by hue, a focus ring that vanished over a filled row, a chart
// with a label that said how many runs it drew and not which way it went. All three are properties of
// the composed page in a theme at a width, so all three need a browser.
//
// axe-core would be the reflex, and it is the right tool in a project that can take the dependency.
// The rules here are written out instead: a rules engine reports what it recognises, and two of the
// four gaps this file exists to close — a chart with no text alternative, a status that carries its
// meaning in hue — are ones it cannot recognise, because they are facts about this app's own idioms.
// ADR 0034 records that reasoning and what it leaves unverified. There are ten rules, each named
// after the success criterion it enforces, and each one exists because it caught something:
//
//   1.1.1  every decorative icon is hidden from the reader, every meaningful one is labelled
//   1.3.1  one h1 per page, and no heading level skipped on the way down
//   1.4.1  a status carries a word and a shape, and a chart states its trend
//   1.4.3  text meets 4.5:1, or 3:1 where it is large
//   2.4.1  the bypass links are the first tab stops and land on something focusable
//   2.4.7  focus is visible on every control, at 2px or more, and 2.4.11 nothing covers or clips it
//   2.5.8  a target is at least 24px in its smaller dimension
//   3.1.1  the document declares its language
//   4.1.2  every control has a name a screen reader can announce
//
// What it does not check matters as much. It cannot judge whether a label is a good label, whether the
// reading order makes sense, or whether an error message helps — 1.3.2, 2.4.6 and 3.3.3 are read by a
// person, and docs/audit records that reading. It sees nothing behind a hover or inside a closed menu.
//
// The page-side rules are strings rather than functions for the same reason they are in
// check-viewport.mjs: this file is linted with Node's globals, so code that names `document` has to be
// held as text and handed to the page. Read them as page code that happens to live in a string.
//
//   npm run dev            # in another terminal, with a scan run in it
//   npm run check:a11y
//
// `ROUTES=/,/findings` narrows the sweep while fixing one page.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, requireIdentity, requireScan, routeRestCeiling, settle } from './browser.mjs';
import { coverageProblems, isParameterised, productionRoutes, routerSource } from './routes.mjs';

const ORIGIN = process.env.ORIGIN ?? 'http://localhost:8000';

const CHROME_MIN_WIDTH_PX = Number(
  /export const CHROME_MIN_WIDTH_PX = (\d+)/.exec(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../client/src/components/shell/chrome-width.ts'),
      'utf8'
    )
  )?.[1]
);
if (!Number.isFinite(CHROME_MIN_WIDTH_PX)) {
  throw new Error('check-a11y could not read CHROME_MIN_WIDTH_PX from chrome-width.ts');
}

/**
 * The two browser windows supported by the pilot under ADR 0108.
 */
const WIDTHS = [
  { name: '1512x845', width: 1512, height: 845 },
  { name: '1280x800', width: 1280, height: 800 },
];

/**
 * Every route, in the order the router declares them, plus the instance a parameterised one needs.
 *
 * This was a hand-written array and it was nine routes short of the app: `/warehouses`, `/jobs`,
 * `/exceptions` and `/improvements` had never been rendered by this sweep, and the sweep's own summary
 * line said it checked every route. The same drift, for the same reason, as the served-app sweep that
 * had never loaded `/jobs` — a second copy of the route table that nobody edits when a route is added.
 *
 * So the list is the router's, and `coverageProblems` fails the check if a served route is neither swept
 * nor exempted with a reason below.
 */
const PARAMETERISED = new Map([
  // The deepest layout in the app: a scrolling summary rail beside a paged list. A fixed pillar id
  // rather than a live one, because the catalogue always has this pillar and the layout does not
  // depend on which.
  ['/pillars/:pillarId', '/pillars/security-compliance-and-privacy'],
]);

/**
 * Routes this sweep does not render, each with the reason. Held against the router by
 * `coverageProblems`, so one that outlives its route fails rather than reading as a decision.
 */
const NOT_SWEPT = new Map([
  ['*', 'the catch-all, which has no path of its own'],
  // Four routes keyed by a record. A static sweep cannot name one that exists, and pointing them at a
  // made-up id renders the not-found state rather than the page — which would pass, and would be a
  // check on an empty state claiming to be a check on the page. `drive-labs.mjs` reaches these by
  // following a link to a real instance, and that is where they are covered.
  ['/review/:reviewId', 'keyed by a review that has to exist; reached from a link in drive-labs.mjs'],
  ['/history/:scanId', 'keyed by a run that has to exist; reached from a link in drive-labs.mjs'],
  ['/report/:resultId', 'keyed by a final result that has to exist; reached from a link in drive-labs.mjs'],
  ['/improvements/:planId', 'keyed by a plan that has to exist; reached from a link in drive-labs.mjs'],
  ['/months/:month', 'keyed by a published month that has to exist; reached from a link in drive-labs.mjs'],
]);

const PRODUCTION = productionRoutes(routerSource());
const DECLARED = PRODUCTION.map(({ path }) => PARAMETERISED.get(path) ?? path).filter(
  (path) => !NOT_SWEPT.has(path) && !isParameterised(path) && path !== '*'
);

const ROUTES = process.env.ROUTES != null ? process.env.ROUTES.split(',') : DECLARED;

// Reported before Chrome starts, because the failure is about the list rather than about a page, and
// waiting until after a two-minute sweep to say the list was incomplete wastes the run.
const uncovered = coverageProblems(DECLARED, {
  exempt: NOT_SWEPT,
  what: 'rendered by check:a11y',
  routes: PRODUCTION,
});
if (uncovered.length > 0) {
  process.stderr.write(`check:a11y does not cover the app it says it covers.\n\n`);
  for (const problem of uncovered) process.stderr.write(`  - ${problem}\n`);
  process.exit(1);
}

/*
 * The rules, run in the page.
 *
 * One expression rather than nine, because each one walks the same tree and a sweep that laid the
 * tree out nine times took eleven seconds a page. Every failure comes back as a sentence naming the
 * criterion and the element, so the output reads without opening this file.
 */
const PROBE = `(() => {
  const problems = [];
  const say = (criterion, message) => problems.push({ criterion, message });

  /** Enough of an element to find it again: its tag, its own classes and the first of its words. */
  const name = (node) => {
    const classes = (node.className && node.className.toString ? node.className.toString() : '')
      .split(/\\s+/)
      .filter((part) => part.startsWith('wa-'));
    const text = (node.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
    const label = [node.tagName.toLowerCase()].concat(classes.slice(0, 2)).join('.');
    return text !== '' ? label + ' "' + text + '"' : label;
  };

  const shown = (node) => {
    const style = getComputedStyle(node);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };

  /*
   * Off-screen but readable, which is something this app does on purpose.
   *
   * 'sr-only' clips a label to a pixel and leaves it in the accessibility tree; the collapsed
   * navigation rail is built out of them. They are exempt from anything measured in pixels and
   * included in everything about names.
   */
  const clipped = (node) => {
    if (node.closest('.sr-only, [class*="sr-only"]') != null) return true;
    // The bypass links hide with a clip-path rather than a class, and are a pixel until focused.
    for (let walk = node; walk != null; walk = walk.parentElement) {
      if (getComputedStyle(walk).clipPath.startsWith('inset(50%')) return true;
    }
    return false;
  };

  // ---- 1.1.1 icons ------------------------------------------------------------------------------
  for (const svg of document.querySelectorAll('svg')) {
    const labelled =
      svg.getAttribute('aria-label') != null ||
      svg.getAttribute('aria-labelledby') != null ||
      svg.querySelector('title') != null ||
      // xyflow wraps every labelled edge group in a separate layout SVG. The accessible graphic is
      // the child role=img, not that implementation container; demanding a second label on the SVG
      // reported each of the 221 edges as an unlabeled icon even though the child carries its exact
      // source and target. A nested image must itself be labelled to satisfy this branch.
      svg.querySelector('[role="img"][aria-label], [role="img"][aria-labelledby], [role="img"] title') != null;
    const hidden = svg.getAttribute('aria-hidden') === 'true' || svg.closest('[aria-hidden="true"]') != null;
    if (svg.getAttribute('role') === 'img') {
      if (!labelled) say('1.1.1', name(svg) + ' is role=img with no label');
    } else if (!hidden && !labelled) {
      say('1.1.1', name(svg) + ' is neither hidden from the reader nor labelled');
    }
  }
  for (const image of document.querySelectorAll('img')) {
    if (image.getAttribute('alt') == null) say('1.1.1', name(image) + ' has no alt');
  }

  // ---- 1.3.1 headings ---------------------------------------------------------------------------
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter((node) => shown(node) || clipped(node));
  const firsts = headings.filter((node) => node.tagName === 'H1');
  if (firsts.length === 0) say('1.3.1', 'the page has no h1');
  if (firsts.length > 1) say('1.3.1', 'the page has ' + firsts.length + ' h1 elements');
  let previous = 0;
  for (const heading of headings) {
    const level = Number(heading.tagName.slice(1));
    if (previous !== 0 && level > previous + 1) {
      say('1.3.1', name(heading) + ' jumps from h' + previous + ' to h' + level);
    }
    previous = level;
  }

  // ---- 1.4.1 status in two channels, and a chart that states its trend --------------------------
  for (const status of document.querySelectorAll('[data-status]')) {
    if (!shown(status)) continue;
    if ((status.textContent || '').trim() === '') say('1.4.1', name(status) + ' states a status with no word in it');
    if (status.querySelector('svg') == null) say('1.4.1', name(status) + ' states a status with no shape in it');
  }
  for (const chart of document.querySelectorAll('[data-chart]')) {
    const label = chart.getAttribute('aria-label') || '';
    // The reference requires a text summary for a chart. A mark-only series with no comparable
    // points deliberately draws no line, so its honest summary is that no movement can be read —
    // forcing "level" there would state the flat trend the component refused to infer.
    if (!/\\b(up|down|level|rose|fell)\\b|no movement can be read/i.test(label)) {
      say('1.4.1', name(chart) + ' draws a trend its label does not state: "' + label + '"');
    }
  }

  // ---- 1.4.3 contrast ---------------------------------------------------------------------------
  const parse = (colour) => {
    const parts = /rgba?\\(([^)]+)\\)/.exec(colour);
    if (parts == null) return null;
    const numbers = parts[1].split(/[,/\\s]+/).filter((part) => part !== '').map(Number);
    return { r: numbers[0], g: numbers[1], b: numbers[2], a: numbers.length > 3 ? numbers[3] : 1 };
  };
  const over = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  });
  const luminance = (colour) => {
    const channel = (value) => {
      const scaled = value / 255;
      return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(colour.r) + 0.7152 * channel(colour.g) + 0.0722 * channel(colour.b);
  };
  const ratio = (one, two) => {
    const a = luminance(one);
    const b = luminance(two);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };

  /** The colour behind an element: every translucent background above it, composited down to white. */
  const behind = (node) => {
    const stack = [];
    for (let walk = node; walk != null; walk = walk.parentElement) {
      const style = getComputedStyle(walk);
      if (style.backgroundImage !== 'none') return null; // A gradient or an image; not ours to judge.
      const colour = parse(style.backgroundColor);
      if (colour == null || colour.a === 0) continue;
      stack.push(colour);
      if (colour.a === 1) break;
    }
    const base = { r: 255, g: 255, b: 255, a: 1 };
    return stack.reduceRight((below, above) => over(above, below), base);
  };

  const unchecked = [];
  for (const node of document.querySelectorAll('*')) {
    const direct = [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim() !== '');
    if (!direct || !shown(node) || clipped(node)) continue;
    const style = getComputedStyle(node);
    const foreground = parse(style.color);
    if (foreground == null) continue;
    const background = behind(node);
    if (background == null) {
      unchecked.push(name(node));
      continue;
    }
    const size = Number.parseFloat(style.fontSize);
    const weight = Number(style.fontWeight) || 400;
    // WCAG's "large": 18pt, or 14pt bold. In CSS pixels at the default ratio, 24px and 18.66px.
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    const measured = ratio(over(foreground, background), background);
    if (measured + 0.05 < need) {
      say('1.4.3', name(node) + ' is ' + measured.toFixed(2) + ':1 at ' + size + 'px/' + weight + ', needs ' + need + ':1');
    }
  }

  // ---- 2.5.8 target size ------------------------------------------------------------------------
  /*
   * The box a pointer actually has to hit, which is not always the element's own.
   *
   * A row link stretches an absolutely positioned ::after over its whole row — the pattern the
   * stylesheet documents and the reason the pillar matrix has a 40px hit area rather than an 18px one.
   * Measuring the anchor there reports every row in the app as an undersized target, which is the
   * opposite of true.
   */
  const hitBox = (target) => {
    if (target.classList.contains('wa-row-link')) {
      const row = target.closest('tr,.wa-row');
      if (row != null) return row.getBoundingClientRect();
    }
    return target.getBoundingClientRect();
  };

  const targets = [...document.querySelectorAll('a[href],button,input,select,textarea,[role="button"]')].filter(
    (target) => shown(target) && !clipped(target)
  );
  const boxes = targets.map(hitBox);

  for (const [index, target] of targets.entries()) {
    // The inline exception: a link in a sentence is sized by the sentence, not by its author.
    if (target.tagName === 'A' && getComputedStyle(target).display.startsWith('inline')) continue;
    const box = boxes[index];
    if (Math.min(box.width, box.height) + 0.5 >= 24) continue;

    /*
     * The spacing exception, which is the half of 2.5.8 that is usually skipped.
     *
     * An undersized target passes if a 24px circle centred on it touches no other target's circle —
     * so a 16px-tall caption link with room around it conforms, and the criterion is not a demand that
     * every link be 24px tall. Without this the check reported nineteen failures on the overview, all
     * of them links with a clear 20px of space either side, and the fix it implied would have added
     * 8px of padding to every caption in the app.
     */
    const centre = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    const crowded = boxes.some((other, at) => {
      if (at === index) return false;
      const point = { x: other.left + other.width / 2, y: other.top + other.height / 2 };
      return Math.hypot(point.x - centre.x, point.y - centre.y) < 24;
    });
    if (crowded) {
      say('2.5.8', name(target) + ' is ' + box.width.toFixed(0) + 'x' + box.height.toFixed(0) +
        ', under 24px, and another target sits inside its 24px circle');
    }
  }

  // ---- 4.1.2 names ------------------------------------------------------------------------------
  for (const control of document.querySelectorAll('a[href],button,input,select,textarea,[role="button"]')) {
    if (!shown(control)) continue;
    if (control.getAttribute('aria-hidden') === 'true') continue;
    const named =
      (control.textContent || '').trim() !== '' ||
      control.getAttribute('aria-label') != null ||
      control.getAttribute('aria-labelledby') != null ||
      control.getAttribute('title') != null ||
      (control.id !== '' && document.querySelector('label[for="' + control.id + '"]') != null) ||
      control.closest('label') != null;
    if (!named) say('4.1.2', name(control) + ' has no accessible name');
  }

  // ---- 3.1.1 language, 2.4.2 title --------------------------------------------------------------
  if ((document.documentElement.getAttribute('lang') || '') === '') say('3.1.1', 'html has no lang attribute');
  if ((document.title || '').trim() === '') say('2.4.2', 'the document has no title');

  return { problems, unchecked: [...new Set(unchecked)] };
})()`;

/*
 * Focus, which has to be driven rather than simulated.
 *
 * The first version of this called `element.focus()` and read the outline back, and reported that
 * every link in the app drew no ring. It was wrong: `:focus-visible` does not match a link focused
 * from script, by design — the browser only shows the ring when it believes a keyboard put focus
 * there. So the check presses Tab, through the protocol, exactly as a reader would, and asks the
 * active element what it draws after each press.
 *
 * Both rings are demanded. The outline is what must be 2px: a control that indicates focus by
 * recolouring its own border passes an eye test and fails a reader who cannot tell that border from
 * the one it had a moment ago.
 */
const FOCUSED = `(() => {
  const node = document.activeElement;
  if (node == null || node === document.body) return null;

  const style = getComputedStyle(node);
  const row = node.closest('tr,.wa-row');
  const classes = (node.className && node.className.toString ? node.className.toString() : '')
    .split(/\\s+/)
    .filter((part) => part.startsWith('wa-'));
  const words = (node.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 30);
  const box = node.getBoundingClientRect();

  /*
   * 2.4.11, focus not obscured: whatever is drawn at the centre of the focused control should be the
   * control. A sticky header that covers the thing you just tabbed to is the failure this catches.
   *
   * Sampled per line box rather than at the centre of the bounding box, because an inline link that
   * wrapped has a bounding box its own text is nowhere near. This check reported two such links as
   * covered — "What this app can reach →" on /improvements at 860px and a warehouse name on /report
   * — and both were false: each had fragments of 84x16 and 75x16 on consecutive lines, and the centre
   * of their union landed in the whitespace between them, on the paragraph. Measured on the running
   * app, the centre of each fragment returns the link. Two of the six failures this check was
   * reporting were its own, which is the reason to sample what the element covers rather than what
   * its rectangle covers.
   *
   * Every fragment, not any, and that is the criterion rather than leniency: 2.4.11 asks that a
   * focused control not be *entirely* hidden. A block element has one fragment and is measured
   * exactly as before.
   */
  const parts = [...node.getClientRects()].filter((part) => {
    if (part.width <= 0 || part.height <= 0) return false;
    const middle = { x: part.left + part.width / 2, y: part.top + part.height / 2 };
    // Off-screen fragments are not obscured by anything: elementFromPoint returns null outside the
    // viewport, and counting that as covered would report every control below the fold.
    return middle.x >= 0 && middle.x <= window.innerWidth && middle.y >= 0 && middle.y <= window.innerHeight;
  });
  const covered =
    parts.length > 0 &&
    parts.every((part) => {
      const at = document.elementFromPoint(part.left + part.width / 2, part.top + part.height / 2);
      return at != null && at !== node && !node.contains(at);
    });

  /*
   * The same criterion, measured rather than sampled.
   *
   * A control scrolled to rest half outside the pane that holds it is obscured by that pane's edge,
   * and the centre sample only notices when the clipped part happens to include the centre. It found
   * the decision form's reason field because the overhang was most of the box; a third of a box
   * hanging out is the same fault and would have passed. So ask the scrollport directly: a focused
   * control should be inside the thing that scrolled it.
   *
   * Only the vertical axis, because that is the axis these panes scroll on, and only where the
   * control could fit — a control taller than its scrollport cannot be wholly inside it and is not
   * failing this by being large. One pixel of tolerance: flush with the edge is inside it.
   */
  let scroller = node.parentElement;
  while (scroller != null) {
    const how = getComputedStyle(scroller).overflowY;
    if ((how === 'auto' || how === 'scroll') && scroller.scrollHeight > scroller.clientHeight) break;
    scroller = scroller.parentElement;
  }
  const port = scroller == null ? null : scroller.getBoundingClientRect();
  const clipped =
    port != null &&
    box.height > 0 &&
    box.height <= port.height &&
    (box.top < port.top - 1 || box.bottom > port.bottom + 1);

  return {
    what: node.tagName.toLowerCase() + (classes.length > 0 ? '.' + classes[0] : '') + ' "' + words + '"',
    ringed: style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) >= 2,
    // A row link hands its ring to the row, which is the pattern the stylesheet documents.
    lent: row != null && row.matches(':has(:focus-visible)') && getComputedStyle(row).outlineStyle !== 'none',
    onScreen: box.bottom > 0 && box.top < window.innerHeight,
    covered,
    clipped,
    overhang: clipped ? Math.round(Math.max(port.top - box.top, box.bottom - port.bottom)) : 0,
  };
})()`;

/** One Tab, as a key event rather than a focus call, so the browser counts it as keyboard input. */
async function tab(page) {
  for (const type of ['keyDown', 'keyUp']) {
    await page.send('Input.dispatchKeyEvent', {
      type,
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: 9,
    });
  }
}

/**
 * Tabs through the page and reports what focus looked like at each stop.
 *
 * Bounded at 60 stops: the longest page here has around forty, and a bound means a page that traps
 * focus in a loop fails on time rather than hanging. Stops are deduplicated by description, so a list
 * of thirty identical row links counts once.
 */
async function tabbed(page, stops = 60) {
  const faults = new Set();
  let seen = 0;
  let first = null;

  /*
   * Focus leaves the document at the end of the order and returns on the next press, so a stop with
   * nothing focused is not the end of the walk. Two in a row is. Without this the walk stopped at the
   * first gap, which is why the same page reported 48 stops in one theme and 23 in the other.
   */
  let empty = 0;

  for (let step = 0; step < stops; step += 1) {
    await tab(page);
    const focus = await page.evaluate(FOCUSED);
    if (focus == null) {
      empty += 1;
      if (empty > 1) break;
      continue;
    }
    empty = 0;
    if (first == null) first = focus.what;
    else if (focus.what === first && step > 2) break; // Wrapped around; the page has no more stops.
    seen += 1;

    if (!focus.ringed && !focus.lent) faults.add(`2.4.7 — ${focus.what} draws no focus ring`);
    if (focus.covered && focus.onScreen) faults.add(`2.4.11 — ${focus.what} is covered by something else`);
    if (focus.clipped && focus.onScreen) {
      faults.add(`2.4.11 — ${focus.what} rests ${String(focus.overhang)}px outside the pane that scrolled it`);
    }
  }

  return { faults: [...faults], stops: seen };
}

/**
 * 2.4.1: the bypass links come first, and each one lands somewhere focus can go.
 *
 * Two groups, two rules. The shell's group leads the document; a workspace bypass leads its own grid.
 */
const BYPASS = `(() => {
  /*
   * Only the links the page actually offers, and only the stops a keyboard can actually reach.
   *
   * The bypass to the navigation column is dropped below 900px, where there is no column to bypass —
   * a link is not a fault for being absent when its target is. And the collapsed chrome at that width
   * keeps its nav links in the document under a \`display: none\` ancestor, where the browser will not
   * send focus; asking each node for its own display said they were reachable and put ten phantom
   * stops in front of the bypass links. A box or no box is the question, so ask for the boxes.
   */
  const rendered = (node) => node.getClientRects().length > 0;
  const links = [...document.querySelectorAll('.wa-skip-links a')].filter(rendered);
  if (links.length === 0) return ['the page has no bypass links'];

  const faults = [];
  const focusable = [...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')].filter(
    (node) => node.tabIndex >= 0 && rendered(node)
  );
  const first = focusable.slice(0, links.length);
  if (!links.every((link, index) => first[index] === link)) faults.push('the bypass links are not the first tab stops');

  /*
   * A selection workspace carries a second bypass, and it is judged by a different rule.
   *
   * The document's group above must be the first tab stops on the page. A pane bypass must not: the
   * whole point of it is to sit where the region it skips begins, which on an inspector page is well
   * inside the document. So the rule for this one is that it is the first focusable thing *within its
   * own pane grid* — a bypass a reader reaches only after tabbing the list it was meant to skip is a
   * link that does nothing.
   *
   * Checked rather than exempted. Moving these off \`.wa-skip-links\` is what stopped ten false 2.4.1
   * failures, and had it stopped there it would have taken away the signal instead of the fault.
   */
  const workspaces = [...document.querySelectorAll('.wa-panes, .wa-task-workspace')].filter(rendered);
  for (const grid of workspaces) {
    const inside = [...grid.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')].filter(
      (node) => node.tabIndex >= 0 && rendered(node)
    );
    const skip = grid.querySelector('.wa-pane-skip a, .wa-task-workspace-skip a');
    if (skip == null || !rendered(skip)) {
      faults.push('a selection workspace offers no bypass into its task');
      continue;
    }
    if (inside[0] !== skip) faults.push('the workspace bypass is not its first tab stop');
    links.push(skip);
  }

  for (const link of links) {
    const where = (link.textContent || 'a bypass link').trim();
    const target = document.querySelector(link.getAttribute('href') || '');
    if (target == null) {
      faults.push(where + ' points at ' + link.getAttribute('href') + ', which is not on the page');
      continue;
    }
    target.focus();
    if (document.activeElement !== target) faults.push(where + ' lands on a target that cannot take focus');
  }
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  return faults;
})()`;

requireIdentity();
await requireScan(ORIGIN);
const page = await open({ width: WIDTHS[0].width, height: WIDTHS[0].height });

const failures = [];
const rows = [];
const unchecked = new Set();

try {
  for (const scheme of ['light', 'dark']) {
    await page.prefer(scheme);

    for (const window of WIDTHS) {
      await page.resize(window.width, window.height);

      for (const route of ROUTES) {
        const ceiling = routeRestCeiling(route);
        const arrival = await page.goto(`${ORIGIN}${route}`, ceiling == null ? {} : { ceiling });
        const probed = await page.evaluate(PROBE);
        const bypass = await page.evaluate(BYPASS);
        // After the bypass check, which moves focus itself, so the tab walk starts from the top.
        await page.evaluate(`(() => { if (document.activeElement) document.activeElement.blur(); return true; })()`);
        const keyboard = await tabbed(page);

        for (const item of probed.unchecked) unchecked.add(item);
        const where = `${route} at ${window.name} in ${scheme}`;
        // A reading of a page that never came to rest is a reading of a page no reader sees, so it is a
        // failure of this run rather than a note on it. See `97` and `restVerdict`.
        if (!arrival.settled) {
          failures.push(`${where}: still not at rest after ${String(arrival.waited)}ms — ${arrival.reason}`);
        }
        for (const problem of probed.problems) failures.push(`${where}: ${problem.criterion} — ${problem.message}`);
        for (const fault of keyboard.faults) failures.push(`${where}: ${fault}`);
        for (const fault of bypass) failures.push(`${where}: 2.4.1 — ${fault}`);

        if (route === '/checks') {
          const menuVisible = await page.evaluate(`(() => {
            const button = [...document.querySelectorAll('button')].find((node) =>
              (node.textContent || '').includes('Open navigation')
            );
            if (button == null) return false;
            return button.getClientRects().length > 0;
          })()`);
          const expectMenu = window.width < CHROME_MIN_WIDTH_PX;
          if (menuVisible !== expectMenu) {
            failures.push(
              `${where}: Open navigation is ${menuVisible ? 'visible' : 'not visible'}, ` +
                `and the chrome column is ${expectMenu ? 'gone' : 'shown'}`
            );
          }
        }

        rows.push({
          scheme,
          window: window.name,
          route,
          stops: keyboard.stops,
          problems: probed.problems.length + keyboard.faults.length + bypass.length,
        });
        await settle(30);
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
      row.window.padEnd(9),
      row.route.padEnd(42),
      `${String(row.stops).padStart(2)} tab stops`,
      `${String(row.problems)} problems`,
    ].join('  ')
  );
}

if (unchecked.size > 0) {
  console.log(`\n${String(unchecked.size)} elements sit on an image or a gradient, so their contrast was not judged:`);
  for (const item of unchecked) console.log(`  ${item}`);
}

if (failures.length > 0) {
  /*
   * Deduplicated on the sentence, with one example of where it happened.
   *
   * A rule that fails on the shell fails on ten routes in two themes at two widths, and forty copies
   * of one sentence buries the nine other things the sweep found.
   */
  const distinct = [...new Set(failures.map((failure) => failure.slice(failure.indexOf(': ') + 2)))];
  console.error(`\n${String(failures.length)} failures, ${String(distinct.length)} distinct:`);
  for (const one of distinct) {
    const example = failures.find((failure) => failure.endsWith(one));
    console.error(`  ${one}\n      first at ${example?.slice(0, example.indexOf(': ')) ?? 'unknown'}`);
  }
  process.exit(1);
}

console.log(`\nAll ${String(rows.length)} page renders meet the ten rules checked here.`);
