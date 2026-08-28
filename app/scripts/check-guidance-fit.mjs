/*
 * Checks that an authored statement fits the pane it is read in.
 *
 * A verify step's statement is set as code, and code does not reflow: where prose wraps to a second
 * line, a query grows a horizontal scrollbar or pushes the pane wider than the window. The character
 * cap in the schema is not a substitute for measuring, because what overflows is the longest single
 * line and not the total. This opens every requirement that carries one, expands the disclosure the
 * statements sit behind, and asserts each block fits.
 */
import { open, requireScan } from './browser.mjs';

const ORIGIN = process.env.ORIGIN ?? 'http://localhost:8000';

const page = await open();
try {
  await requireScan(ORIGIN);
  await page.goto(`${ORIGIN}/answers`);

  // Taken from the API rather than the list, because the list is paged to what fits and the
  // requirements below the fold are exactly the ones nobody has looked at.
  const controls = await page.evaluate(`
    fetch('/api/attestations')
      .then((response) => response.json())
      .then((body) => body.requirements.map((one) => one.controlId))
  `);
  if (controls.length === 0) throw new Error('The answers page listed no requirements, so this measured nothing.');

  const failures = [];
  let measured = 0;

  for (const control of controls) {
    await page.goto(`${ORIGIN}/answers?control=${encodeURIComponent(control)}`);
    // The statements sit behind a disclosure, and a closed element has no layout to measure.
    await page.evaluate(`
      document.querySelectorAll('details').forEach((element) => { element.open = true; });
      true
    `);
    const blocks = await page.evaluate(`
      Array.from(document.querySelectorAll('pre')).map((block) => ({
        overflow: block.scrollWidth - block.clientWidth,
        text: block.textContent.slice(0, 60),
      }))
    `);
    measured += blocks.length;
    for (const block of blocks) {
      // A pixel or two is rounding. Anything a reader would have to scroll is not.
      if (block.overflow > 2) failures.push(`${control}: overflows by ${String(block.overflow)}px — ${block.text}`);
    }
    const wide = await page.evaluate(`document.documentElement.scrollWidth - window.innerWidth`);
    if (wide > 2) failures.push(`${control}: the page itself is ${String(wide)}px wider than the window`);
  }

  if (measured === 0) throw new Error('No statement was on screen on any requirement, so this measured nothing.');

  if (failures.length > 0) {
    console.error(`\n${String(failures.length)} statement${failures.length === 1 ? '' : 's'} did not fit:\n`);
    for (const failure of failures) console.error(`  ${failure}`);
    console.error('');
    process.exitCode = 1;
  } else {
    console.log(`\n${String(measured)} statements across ${String(controls.length)} requirements fit their pane.\n`);
  }
} finally {
  page.close();
}
