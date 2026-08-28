// A picture of the imports list as it reads the store this server is bound to.
//
// Row 85 changed where that list's numbers come from — a `summary` column rather than the stored
// envelope — and the payload it produces is field-for-field what it produced before. This is the
// check that the page agrees, against a real database with a real collection in it, because a
// payload that is right and a page that stopped rendering it would both pass every test in the tree.

import { mkdirSync, writeFileSync } from 'node:fs';
import { open, settle } from './browser.mjs';

const ORIGIN = process.env.ORIGIN ?? 'http://localhost:8000';
const INTO = process.env.INTO ?? 'build/shots';

mkdirSync(INTO, { recursive: true });

const page = await open({ width: 1512, height: 845 });

try {
  await page.goto(`${ORIGIN}/checks`);
  await settle(2500);

  // The panel is three levels in: it renders only for a pillar holding a requirement no install can
  // be granted, and then only inside the "what you need to be able to see" disclosure. So walk the
  // pillars until one shows it, rather than assuming which one does — that is a fact about the
  // catalogue, and the catalogue changes.
  const PILLARS = `[...document.querySelectorAll('button, [role="tab"], a')]
    .filter((one) => /\\d+ checks/.test(one.textContent ?? '')).length`;
  const pillars = Number(await page.evaluate(PILLARS));
  if (pillars === 0) throw new Error('No pillars on the page — has a scan run?');

  let shown;
  for (let index = 0; index < pillars && shown == null; index += 1) {
    await page.evaluate(`(() => {
      const all = [...document.querySelectorAll('button, [role="tab"], a')]
        .filter((one) => /\\d+ checks/.test(one.textContent ?? ''));
      all[${String(index)}]?.click();
    })()`);
    await settle(900);

    await page.evaluate(`(() => {
      for (const one of document.querySelectorAll('summary, button')) {
        if (/what you need to be able to see/i.test(one.textContent ?? '')) one.click();
      }
    })()`);
    await settle(900);

    shown = await page.evaluate(`(() => {
      const one = document.querySelector('[aria-label="Import admin-collected evidence"]');
      if (one == null) return undefined;
      // The end of the panel, not its start: the upload control is first and the list of what is
      // held is under it, which is the part row 85 changed.
      (one.lastElementChild ?? one).scrollIntoView({ block: 'end' });
      return one.textContent.trim().slice(0, 120);
    })()`);
  }

  if (shown == null) throw new Error('No pillar showed the import panel.');
  await settle(1200);

  // The held collections are themselves behind a count — "N collections imported" — and the fields
  // under it are the ones the summary column now supplies. That is the thing worth a picture.
  const held = await page.evaluate(`(() => {
    for (const one of document.querySelectorAll('summary, button')) {
      if (/collections? imported/i.test(one.textContent ?? '')) {
        one.click();
        return one.textContent.trim();
      }
    }
    return undefined;
  })()`);
  await settle(1000);
  await page.evaluate(`(() => {
    const one = document.querySelector('[aria-label="Import admin-collected evidence"]');
    (one?.lastElementChild ?? one)?.scrollIntoView({ block: 'end' });
  })()`);
  await settle(800);
  console.log(`  held: ${held ?? '(nothing imported)'}`);
  writeFileSync(`${INTO}/imports.png`, await page.screenshot());
  console.log(`imports  ${ORIGIN}/checks\n  panel: ${shown}`);
} finally {
  await page.close();
}
