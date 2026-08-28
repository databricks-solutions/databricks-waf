// Drives ⌘K in a real browser and reports what it did.
//
// A one-off, kept because the palette is the only surface in the app reached by a keystroke rather than
// a URL, and every one of its interesting behaviours is a keypress: does the shortcut open it, does an
// arrow move the highlight, does Enter land on the right page, does Escape give focus back. None of
// that is reachable from `check:a11y`, which navigates by URL.
//
//   npm run dev          # in another terminal, with a scan in it
//   node scripts/drive-palette.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { open, requireScan, settle } from './browser.mjs';

const ORIGIN = process.env.ORIGIN ?? 'http://localhost:8000';
const SHOTS = '.tmp-shots';

/**
 * A picture, or a note that there is none.
 *
 * Captures stop answering for reasons browser.mjs documents at length and nobody has got to the bottom
 * of. Losing one is a lost diagnostic; losing the run because of one throws away every verdict after it.
 *
 * `WAF_NO_SHOTS=1` skips them, and it is not a convenience. A capture that times out leaves this
 * browser unable to produce frames, and an animation that gets no frames never ends — so a dialog
 * whose exit Radix is waiting on stays mounted forever, and this script reports a palette that will
 * not close. It cost an hour to find that the first time. Run without pictures to get the verdicts,
 * with them to get the evidence.
 */
async function shoot(page, name) {
  if (process.env.WAF_NO_SHOTS === '1') return;
  try {
    writeFileSync(`${SHOTS}/${name}.png`, await page.screenshot());
  } catch {
    console.log(`  (no picture of ${name})`);
  }
}

const KEYS = {
  k: { key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, text: 'k' },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
};

async function press(page, name, { meta = false } = {}) {
  const key = KEYS[name];
  for (const type of ['keyDown', 'keyUp']) {
    await page.send('Input.dispatchKeyEvent', {
      type: type === 'keyDown' && key.text != null ? 'keyDown' : type,
      modifiers: meta ? 4 : 0, // 4 is Meta in the protocol's bitmask.
      ...key,
      ...(meta ? { text: undefined } : {}),
    });
  }
  await settle(120);
}

async function type(page, text) {
  for (const character of text) {
    await page.send('Input.dispatchKeyEvent', { type: 'char', text: character });
  }
  await settle(200);
}

/**
 * How long the dialog took to leave the DOM, or that it did not.
 *
 * Waited for rather than slept past. The dialog exits on a 200ms animation and Radix keeps it mounted
 * until that animation ends, so a fixed sleep either reports a closing dialog as an open one or hides
 * a real failure to close behind a generous margin.
 *
 * The wait is on a frame and not on a timer, and that is the whole of why this function exists. This
 * browser has no compositor, and a CSS animation in it does not begin until something asks the page
 * for a frame — so a poll that only queries the DOM watches an animation that never starts, waiting
 * for an `animationend` that is never coming. That reads exactly like a palette that will not close,
 * and it was reported as one for an hour. Asking for the frame is what makes this measure the app.
 */
async function gone(page, within = 2000) {
  const started = Date.now();
  while (Date.now() - started < within) {
    const away = await page.evaluate(`new Promise((done) => {
      requestAnimationFrame(() => done(document.querySelector('[data-slot="dialog-content"]') == null));
    })`);
    if (away === true) return `closed in ${String(Date.now() - started)}ms`;
    await settle(50);
  }
  return `STILL OPEN after ${String(within)}ms`;
}

/** What the palette looks like right now, as facts rather than as a picture. */
const STATE = `(() => {
  const dialog = document.querySelector('[data-slot="dialog-content"]');
  if (dialog == null) return { open: false, focus: document.activeElement?.outerHTML?.slice(0, 90) ?? null };
  const field = dialog.querySelector('[role="combobox"]');
  const active = dialog.querySelector('[data-active="true"]');
  return {
    open: true,
    query: field?.value ?? null,
    focused: document.activeElement === field,
    pointsAt: field?.getAttribute('aria-activedescendant') ?? null,
    activeRow: active?.textContent?.trim() ?? null,
    activeId: active?.id ?? null,
    agrees: active != null && field?.getAttribute('aria-activedescendant') === active.id,
    rows: [...dialog.querySelectorAll('[role="option"]')].map((one) => one.textContent.trim().slice(0, 60)),
    headings: [...dialog.querySelectorAll('.wa-palette-heading')].map((one) => one.textContent.trim()),
    foot: dialog.querySelector('.wa-palette-foot')?.textContent?.trim() ?? null,
  };
})()`;

await requireScan(ORIGIN);
const page = await open({ width: 1440, height: 900 });
mkdirSync(SHOTS, { recursive: true });

const say = (what, value) => console.log(`${what}\n  ${JSON.stringify(value)}\n`);

try {
  await page.goto(`${ORIGIN}/`);

  await press(page, 'k', { meta: true });
  say('after ⌘K on the overview', await page.evaluate(STATE));
  await shoot(page, 'palette-open');

  await type(page, 'tag');
  say('after typing "tag"', await page.evaluate(STATE));
  await shoot(page, 'palette-tag');

  await press(page, 'ArrowDown');
  await press(page, 'ArrowDown');
  say('after two ArrowDowns', await page.evaluate(STATE));

  await press(page, 'ArrowUp');
  say('after one ArrowUp', await page.evaluate(STATE));

  await press(page, 'End');
  say('after End', await page.evaluate(STATE));

  await press(page, 'Escape');
  say('after Escape', {
    dialog: await gone(page),
    // Where the keyboard ended up, because a dialog that closes without handing focus back to the
    // control that opened it leaves the reader nowhere, and that is the half of Escape most easily
    // got wrong. `aria-keyshortcuts` identifies the trigger without depending on its wording.
    focus: await page.evaluate(
      `(() => { const el = document.activeElement; return el == null ? null : el.tagName + (el.getAttribute('aria-keyshortcuts') ?? ''); })()`
    ),
  });

  // Now the whole point: does Enter land where the row said it would.
  await press(page, 'k', { meta: true });
  await type(page, 'serverless');
  const before = await page.evaluate(STATE);
  say('after typing "serverless"', before);
  await shoot(page, 'palette-serverless');
  await press(page, 'Enter');
  const closed = await gone(page);
  await settle(400);
  say('after Enter', {
    url: await page.evaluate('location.pathname + location.search'),
    heading: await page.evaluate("document.querySelector('h1')?.textContent?.trim() ?? null"),
    dialog: closed,
  });

  // An id typed in full, from a page that is not the overview.
  await page.goto(`${ORIGIN}/checks`);
  await press(page, 'k', { meta: true });
  await type(page, 'co-01-03');
  say('after typing an id on /checks', await page.evaluate(STATE));
  await press(page, 'Enter');
  const landed = await gone(page);
  await settle(900);
  say('where the id went', {
    url: await page.evaluate('location.pathname + location.search'),
    dialog: landed,
    // The census page reveals the deep-linked requirement in its pane, so this is the round trip:
    // typed an id into a palette on another page, and read that requirement's own heading.
    pane: await page.evaluate(
      "document.querySelector('[data-selected=\"true\"]')?.textContent?.trim().slice(0, 60) ?? null"
    ),
  });

  // The fallback row, on a phrase no title holds.
  await press(page, 'k', { meta: true });
  await type(page, 'zzzz');
  say('after typing a phrase nothing matches', await page.evaluate(STATE));
  await shoot(page, 'palette-miss');

  await page.prefer('dark');
  await page.goto(`${ORIGIN}/pillars`);
  await press(page, 'k', { meta: true });
  await type(page, 'cost');
  await shoot(page, 'palette-dark');
  say('dark, on "cost"', await page.evaluate(STATE));
} finally {
  page.close();
}
