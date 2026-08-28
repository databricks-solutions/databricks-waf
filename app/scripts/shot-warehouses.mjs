// What the warehouse screens say about the estate, read from a deployed app against a real workspace.
//
// Written for one question: whether a warehouse whose statements are mostly this assessment's still
// occupies a row in the customer's list saying so. It reports the opening sentence, every state badge and
// the selected warehouse's panel, because the defect was a state rather than a number and a screenshot
// alone would not say which state each row is in.
//
//   TOKEN=$(databricks auth token -p labs | jq -r .access_token) \
//   APP=https://<app>.databricksapps.com node scripts/shot-warehouses.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { open, settle } from './browser.mjs';

const origin = (process.env.APP ?? '').replace(/\/$/, '');
const token = process.env.TOKEN ?? '';
const into = process.env.INTO ?? 'build/shots';
if (origin === '' || token === '') {
  console.error('Set APP to the deployed origin and TOKEN to a workspace token.');
  process.exit(2);
}

const READ = `(() => {
  const text = (node) => (node?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const main = document.querySelector('main') ?? document.body;
  return {
    heading: text(main.querySelector('h1, h2')),
    lead: text(main.querySelector('p')),
    rows: Array.from(main.querySelectorAll('[role="row"], li, tr'))
      .map((row) => text(row))
      .filter((one) => one !== '')
      .slice(0, 12),
    everything: text(main).slice(0, 4000),
  };
})()`;

mkdirSync(into, { recursive: true });
const page = await open({ width: 1512, height: 845 });
try {
  await page.send('Network.enable');
  await page.send('Network.setExtraHTTPHeaders', {
    headers: { Authorization: `Bearer ${token}`, 'x-forwarded-access-token': token },
  });

  await page.goto(`${origin}/warehouses`);
  // The page fetches its analysis after mount, so what renders first is a skeleton. `goto` waits for the
  // height to settle, which a table that grows one row at a time can satisfy early.
  await settle(2500);

  const seen = await page.evaluate(READ);
  console.log(`heading: ${seen.heading}`);
  console.log(`lead:    ${seen.lead}\n`);
  for (const row of seen.rows) console.log(`  ${row}`);

  const said = seen.everything;
  console.log('\nwhat the page says about us:');
  for (const phrase of [
    'Measuring ourselves',
    'Only this assessment ran',
    'of the query time on this warehouse',
    'mostly this assessment',
    'statement of yours',
    'Not used',
  ]) {
    console.log(`  ${said.includes(phrase) ? 'present' : 'absent '}  ${phrase}`);
  }

  writeFileSync(`${into}/warehouses.png`, await page.screenshot());
  writeFileSync(`${into}/warehouses.txt`, said);
  console.log(`\nWrote ${into}/warehouses.png`);
} finally {
  await page.close();
}
